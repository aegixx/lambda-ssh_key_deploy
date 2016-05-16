#!/bin/env node

var deploy = require('./index');
var config = require ('./config');
var http = require('http');
var url = require('url');

var listenPort = (config.server && config.server['listenPort']) || 8187;
var listenAddress = (config.server && config.server['listenAddress']) || '0.0.0.0';

http.createServer(function (req, res) {
  var queryData = url.parse(req.url, true).query;

  var key = queryData.key;
  var action = queryData['action'] || "add";
  var instanceId = queryData.instance;
  
  if (queryData['sshuser']) {
    config.ssh.defaultUser = queryData.sshuser
  }
  if (queryData['sshport']) {
    config.ssh.defaultPort = queryData.sshport
  }
  
  if (instanceId && key) {
    console.log('INFO: Processing ['+action+'] on instance ('+instanceId+') with key ('+key+')');
    
    var event = {
      "Records": [
        {
					s3: {
						object: {
							key: key
						},
						bucket: {
							name: config.userKeyBucket
						}
					},
          ec2: {
            instanceId: instanceId
          },
					eventName: action
				}
      ]
    };
    
    processEvent(event);
    
    res.writeHead(200);
    res.end();
  } else {
    console.error('ERROR: Invalid instance ('+instanceId+') or key ('+key+')');
    res.writeHead(422, {"Content-Type": "text/plain"});
    res.end("Both 'instance' and 'key' must be provided.");
  }

}).listen(listenPort, listenAddress);
console.log('Server running at http://'+listenAddress+':'+listenPort+'/');

function processEvent(event) {
	deploy.handler(event, {}, function(error, success) {
		if (error) {
			console.error(error);
			return 1;
		} else if (success) {
			console.log(success);
			return 0;
		} else {
			return 0;
		}
	});
}

