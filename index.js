var spawn = require('child_process').spawn;
var touchstone = require('touchstone');
var browserstack = require('browserstack');
var async = require('async');
var net = require('net');
var util = require('util');
var tapConv = require('tap-test-converter');
var program = require('commander');
var pkg = require('./package');
var streamSplitter = require('stream-splitter');
var http = require('http');
var static = require('node-static');
var fmt = util.format;

var ids = {}; // used to track the test runs
var testResults = [];
var tunnel;
var inShutdown = false;
var resultCollectorPort = 1942;
var portRange = 45032;
var defaultCfgFilePath = './config.json';

program
    .version(pkg.version)
    .option('-c, --config <path to configuration file>')
    .option('-u, --bs_username <browserstack username>')
    .option('-p, --bs_password <browserstack password>')
    .option('-k, --bs_key <browserstack automated testing key>')
    .option('-t, --testfile <path to testfile relative to testing directory>')
    .option('-d, --directory <directory to host files from (defaults to current dir)')
    .option('-v, --verbose', 'output debugging information')
    .parse(process.argv);

var config = require(program.config || defaultCfgFilePath);
config.bs_username = program.bs_username || config.bs_username;
config.bs_password = program.bs_password || config.bs_password;
config.bs_key = program.bs_key || config.bs_key;
config.test_file = program.testfile || config.test_file;
config.directory = program.directory || config.directory;
for (var key in config) {
    if (!config[key]) {
        throw new Error(fmt('%s not set in config or cli arguments', key));
    }
}

var client = browserstack.createClient({
    username: config.bs_username,
    password: config.bs_password
});

async.parallel({
    'fileServer' : function (callback) {
        getPort(function (port) {
            http.createServer(function (req, res) {
                req.addListener('end', function () {
                    new static.Server(config.directory).serve(req, res, function (err, result) {
                        if (err) {
                            log(fmt('Error serving %s - %s', req.url, err.message));
                            res.writeHead(err.status, err.headers);
                            res.end();
                        } else {
                            log(fmt('[%d]: %s', res.statusCode, req.url));
                        }
                    });
                }).resume();
            }).listen(port, function () {
                log(fmt('started fileserver on port %d', port));
                callback(null, port);
            });
        });
    },
    'resultCollector' : function (callback) {
        touchstone.createServer().listen(resultCollectorPort, function () {
            callback(null, resultCollectorPort); // TODO: have we ignored errors here?
        }).on('result', processTestResult);
    }
}, function (err, ports) {
    var tunnelPorts = fmt.apply(this, ['localhost,%d,0,localhost,%d,0'].concat(values(ports)));

    // start tunnel
    tunnel = spawn('java', ['-jar', 'ext/BrowserStackTunnel.jar', config.bs_key, tunnelPorts]);
    if (program.verbose) {
        tunnel.stdout.pipe(process.stdout);
        tunnel.stderr.pipe(process.stderr);
    }

    var splitter = tunnel.stdout.pipe(streamSplitter('\n'));
    splitter.encoding = 'utf8';
    splitter.on('token', function (token) {
        var expected = 'You can now access your local server(s) in our remote browser';
        if (token.substring(0, 61) === expected) {
            log('tunnel started successfully!!');
            launchBrowsers(ports.fileServer);
        }
    });
    splitter.on('done', function () {
        if (!inShutdown) {
            console.log('ERROR: browserstack tunnel failed to start, ' +
                                'see --verbose output for more info');
            process.exit(1);
        }
    });
});

function log (msg) {
    if (program.verbose) {
        console.log(msg);
    }
}

function getPort (cb) {
    var port = portRange;
    portRange += 1;
    var server = net.createServer();
    server.listen(port, function (err) {
        server.once('close', function () {
            cb(port);
        });
        server.close();
    });
    server.on('error', function (err) {
        getPort(cb);
    });
}

function generateShortUUID () {
    return ('0000' + (Math.random()*Math.pow(36,4) << 0).toString(36)).substr(-4);
}

function values (obj) {
    var vals = [];
    for (var key in obj) {
        vals.push(obj[key]);
    }
    return vals;
}

function launchBrowsers (port) {
    for (var i = 0; i < config.browsers.length; i++) {
        var browser = config.browsers[i];
        var id = 'bs_' + generateShortUUID();
        ids[id] = {};
        ids[id].instance = browser;

        browser.url = fmt('http://localhost:%s/%s?id=%s', port, config.test_file, id);

        log('launching: ' + JSON.stringify(browser));

        (function (id) {
            client.createWorker(browser, function (err, worker) {
                if (err) throw err;
                ids[id].worker_id = worker.id;
            });
        })(id);
    }
}

function processTestResult (id, result) {
    testResults.push(result);
    var instance = ids[id].instance;
    var browser = fmt('%s %s (%s)', instance.browser, instance.version, instance.os);

    console.log(fmt('# START -- %s ----------', browser));
    console.log(tapConv(result));
    console.log(fmt('# END ---- %s ----------', browser));

    if (ids[id]) {
        client.terminateWorker(ids[id].worker_id, function (err, data) {
            if (err) throw err;
            log('successfully terminated worker!!: ' + id);
            delete ids[id];
            if (Object.keys(ids).length == 0) {
                var totalFailed = testResults.map(function (x) { return x.failed })
                                             .reduce(function (a, b) { return a + b });
                console.log(fmt('# out of %d test runs, %d failed',
                    testResults.length, totalFailed));
                process.exit((totalFailed > 0 ? 1 : 0));
            }
        });
    }
}

function exit (exitCode) {
    inShutdown = true;
    process.kill(tunnel);
    var workerIds = values(ids).map(function (item) {
        return item.worker_id;
    });
    if (workerIds.length > 0) {
        log(fmt('Stopping browserstack workers: %s', workerIds.join(', ')));
    }
    async.each(workerIds, client.terminateWorker.bind(client), function (err) {
        process.exit(exitCode);
    });
}

process
    .once('SIGINT', exit)
    .once('SIGTERM', exit)
    .once('SIGHUP', exit)
    .once('exit', exit)