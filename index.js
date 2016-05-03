// dependencies
var AWS = require('aws-sdk');
var async = require("async");
var util = require('util');
var extend = require('util')._extend;
var SSH = require('simple-ssh');
var fs = require('fs');
var config = require('./config');

if (config.aws) {
	AWS.config.update(config.aws);
}

// get reference to AWS resources
var ec2 = new AWS.EC2();
var s3 = new AWS.S3({
	signatureVersion: 'v4'
});

var _TRACE = config.logging.traceEnabled;
var _DEBUG = config.logging.debugEnabled;

function trace(msg) {
  if (_TRACE) {
    var ts =   (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
    var args = Array.prototype.slice.call(arguments, 1);
    args.splice(0, 0, ts + " TRACE: " + msg);
    console.log.apply(this, args);
  }
}

function debug(msg) {
  if (_DEBUG) {
    var ts =   (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
    var args = Array.prototype.slice.call(arguments, 1);
    args.splice(0, 0, ts + " DEBUG: " + msg);
    console.log.apply(this, args);
  }
}

function error(msg) {
  var ts =   (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  var args = Array.prototype.slice.call(arguments, 1);
  args.splice(0, 0, ts + " ERROR: " + msg);
  console.error.apply(this, args);
}

function warn(msg) {
  var ts =   (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  var args = Array.prototype.slice.call(arguments, 1);
  args.splice(0, 0, ts + " WARN: " + msg);
  console.error.apply(this, args);
}

function info(msg) {
  var ts =   (new Date()).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  var args = Array.prototype.slice.call(arguments, 1);
  args.splice(0, 0, ts + " INFO: " + msg);
  console.log.apply(this, args);
}


function onStart(event, context, onFinish) {
	trace("onStart(event, context, onFinish)", util.inspect(event, {depth: 5}));

	function _retrieveS3Object(bucket, key, onDone) {
		trace("_retrieveS3Object('" + bucket + "', '" + key + "', onDone)");

		if (!bucket) {
			throw "EXCEPTION: _retrieveS3Object(...) - 'bucket' parameter is missing."
		}

		if (!key) {
			throw "EXCEPTION: _retrieveS3Object(...) - 'key' parameter is missing."
		}

		s3.getObject({
				Bucket: bucket,
				Key: key
			},
			function (err, data) {
				if (err) {
					if (err.code === 'NoSuchKey') {
						warn(err + " (" + bucket + "/" + key + ")");
						onDone();
					} else {
						onDone("_retrieveS3Object('" + bucket + "', '" + key + "', onDone) - " + err);
					}
				} else {
					onDone(null, data.Body.toString());
				}
			});
	}

	function _finish(error, success) {
		trace("_finish('" + error + "', '" + success + "')");

		if (error) {
			onFinish("ERROR: " + error);
		} else if (success) {
			onFinish(null, "SUCCESS: " + success);
		} else {
			onFinish();
		}
	}

	function _downloadPublicKeys(records, onDone) {
		trace("_downloadPublicKeys(records, onDone)");

		function _getBody(item, onDone) {
			trace("_getBody(item, onDone)");

			// Parse out the s3 bucket / key
			var bucket = item.s3.bucket.name;
			var key = item.s3.object.key.replace(/\+/g, " ");
			var action = null;
			if (item.eventName.match(/ObjectCreated/)) {
				action = 'add';
			} else if (item.eventName.match(/ObjectRemoved/)) {
				action = 'delete';
			} else {
				return onDone("Unknown action (" + item.eventName + ") for '" + bucket + "/" + key + "'");
			}

			if (action === 'add') {
				_retrieveS3Object(bucket, key, function (err, body) {
					if (err) {
						onDone("_getBody(item, onDone) on '" + bucket + "/" + key + "' - " + err);
					} else {
						onDone(null, {
							bucket: bucket,
							key: key,
							action: action,
							username: key.substr(0, key.indexOf('/')),
							body: body.trim()
						});
					}
				});
			} else {
				onDone(null, {
					bucket: bucket,
					key: key,
					action: action,
					username: key.substr(0, key.indexOf('/')),
					body: null
				});
			}
		}

		async.map(records, _getBody, function (err, results) {
			if (err) {
				onDone("_downloadPublicKeys(records, onDone) :: " + err);
			} else {
				onDone(null, results);
			}
		});
	}

	function _getEC2Instances(onDone) {
		trace("_getEC2Instances(onDone)");

		function _getInstances(reservation, onDone) {
			trace("_getInstances(reservation, onDone)");

			if (!reservation) {
				throw "EXCEPTION: _getInstances(reservation, onComplete) - 'reservation' parameter is missing.";
			}

			function _getInstanceDetail(instance, onDone) {
				trace("_getInstanceDetail(instance, onDone)");

				if (!instance) {
					throw "EXCEPTION: _getInstanceDetail(instance, onComplete) - 'instance' parameter is missing.";
				}

				var publicIpAddress = instance.PublicIpAddress;
				var privateIpAddress = instance.PrivateIpAddress;
				var ipAddress = null;
				var instanceName = privateIpAddress;
				var keyName = instance.KeyName;
				var sshPort = config.ssh.defaultPort;
				var sshUser = config.ssh.defaultUser;
				for (var i = 0; i < instance.Tags.length; i++) {
					var tag = instance.Tags[i];
					if (tag.Key === config.ec2Tags.name) {
						instanceName = tag.Value;
					}
					if (tag.Key === config.ec2Tags.overridePort) {
						sshPort = tag.Value;
					}
					if(tag.Key === config.ec2Tags.overrideUser) {
						sshUser = tag.Value;
					}
					if (tag.Key === config.ec2Tags.overrideUsePublicIP && tag.Value === 'true') {
						ipAddress = publicIpAddress;
					}

				}

				onDone(null, {
					name: instanceName,
					ipAddress: ipAddress || privateIpAddress,
					keyName: keyName,
					sshUser: sshUser,
					sshPort: sshPort
				});
			}

			async.map(reservation.Instances, _getInstanceDetail, function (err, results) {
				if (err) {
					onDone("_getInstanceDetail(reservation, onDone) :: " + err);
				} else {
					onDone(null, results);
				}
			});
		}

		ec2.describeInstances({
			Filters: [{
				Name: 'tag:' + config.ec2Tags.instanceFilter,
				Values: [
					'true'
				]
			}]
		}, function (err, data) {
			if (err) {
				onDone("getEC2Instances(reservation, onDone) - " + err);
			} else {
				async.map(data.Reservations, _getInstances, function (err, results) {
					if (err) {
						onDone("getEC2Instances(reservation, onDone) :: " + err);
					} else {
						onDone(null, [].concat.apply([], results)); // Flatten the array before returning
					}
				});
			}
		});
	}

	function _syncUsers(record, onDone) {
		trace("_syncUsers(record, onDone)");

		var instance = record.instance;
		var publicKeys = record.publicKeys;
		var masterKeyBody = record.masterPrivateKeyBody;

		if (!masterKeyBody) {
			warn('No master key available for instance ' + instance.name + ' (' + instance.ipAddress + ')');
			onDone(null, record);
		} else if (publicKeys.length > 0) {
			debug('Connecting to ' + instance.name + ' (' + instance.sshUser + '@' + instance.ipAddress + ':' + instance.sshPort + ') using master key: ' + instance.keyName);

			var ssh = new SSH({
				host: instance.ipAddress,
				user: instance.sshUser,
				port: instance.sshPort,
				key: masterKeyBody
			});

			function _queueUserCommand(ssh, publicKey, onExit) {
				trace("_queueUserCommand(ssh, publicKey, onExit) - " + publicKey.action + " :: " + publicKey.username);

				var action = publicKey.action;
				var username = publicKey.username;
				var keyBody = publicKey.body;

				var cmd = null;
				if (action === 'add') {
					cmd = 'echo "' + keyBody + '" | sudo ~/manageUser ' + action + ' ' + username;
				} else {
					cmd = 'sudo ~/manageUser ' + action + ' ' + username;
				}
				debug("Queueing SSH Command: " + cmd);
        ssh.exec(cmd, {
					pty: true,
					exit: function (code, stdout, stderr) {
						onExit(publicKey, code, stdout, stderr);
					}
				});

			}

			function _commandDone(publicKey, code, stdout, stderr) {
				if (stdout) {
					debug("SSH (stdout) - " + stdout);
				}
				if (stderr) {
					warn("SSH (stderr) - " + stderr);
				}
				debug("SSH exit code: " + code);

				if (code === 0) {
					publicKey['success'] = true;
				} else {
					publicKey['fail'] = true;
				}

				// Make sure we are done
				if (!publicKeys.find(function (rec) {
						return !(rec.success || rec.fail);
					})) {
					ssh.end();
					onDone(null, record);
				}
			}

			// Make sure system has script
			ssh.exec('cat > ~/manageUser && chmod +x ~/manageUser', {
				in: fs.readFileSync(__dirname + '/manageUser.sh')
			});

			for (var i = 0; i < publicKeys.length; i++) {
				var publicKey = publicKeys[i];
				_queueUserCommand(ssh, publicKey, _commandDone);
			}

			ssh.start({
				fail: function(err) {
					error('SSH Failed to connect to ' + instance.name + ' (' + instance.sshUser + '@' + instance.ipAddress + ':' + instance.sshPort + ')', err);
					ssh.end();
					onDone(null, record);
				}
			});
		} else {
			// Continue even if you can't sync to one instance
			onDone(null, record);
		}
	}

	async.parallel([
		async.apply(_downloadPublicKeys, event.Records),
		_getEC2Instances
	], function _(err, results) {
		if (err) {
			_finish("onStart(event, context, onFinish) :: " + err);
		} else {
			var publicKeys = results[0];
			var instances = results[1];

			info(publicKeys.length + " public key(s) to update on " + instances.length + " instance(s)");

			function _downloadMasterKeys(records, onDone) {
				trace("_downloadMasterKeys(records, onDone)");

				function _getBody(keyName, onDone) {
					trace("_getBody('" + keyName + "', onDone)");

					_retrieveS3Object(config.masterKeyBucket, keyName, function (err, body) {
						if (err) {
							onDone("_getBody(keyName, onDone) on '" + config.masterKeyBucket + "/" + keyName + "' - " + err);
						} else {
							onDone(null, body);
						}
					});
				}

				// Get only unique keys
				var uniqKeyNames = [];
				for (var i = 0; i < records.length; i++) {
					var record = records[i];
					if (uniqKeyNames.indexOf(record.instance.keyName) < 0) {
						uniqKeyNames.push(record.instance.keyName);
					}
				}

				async.map(uniqKeyNames, _getBody, function (err, keyBodies) {
					if (err) {
						onDone("_downloadMasterKeys(records, onDone) :: " + err);
					} else {
						for (var i = 0; i < records.length; i++) {
							var record = records[i];
							record['masterPrivateKeyBody'] = keyBodies[uniqKeyNames.indexOf(record.instance.keyName)];
						}
						onDone(null, records);
					}
				});
			}

			function _applyToInstances(records, onDone) {
				trace("_applyToInstances(records, onDone)");

				async.map(records, _syncUsers, function (err, processedRecords) {
					if (err) {
						onDone("_applyToInstances(records, onDone) :: " + err);
					} else {
						onDone(null, processedRecords);
					}
				});
			}

			var records = [];
			for (var i = 0; i < instances.length; i++) {
				var instance = instances[i];

				// Clone public keys so you can track success/fail for each instance
				var clonedPublicKeys = [];
				for (var j = 0; j < publicKeys.length; j++) {
					clonedPublicKeys.push(extend({}, publicKeys[j]));
				}
				
				records.push({
					instance: instance,
					publicKeys: clonedPublicKeys
				});
			}

			if (records.length > 0) {
				async.waterfall([
					async.apply(_downloadMasterKeys, records),
					_applyToInstances
				], function (err, processedRecords) {
					if (err) {
						_finish("onStart(event, context, onFinish) :: " + err);
					} else {
						for (var i = 0; i < processedRecords.length; i++) {
							var rec = processedRecords[i];
							var success = rec.publicKeys.reduce(function (sum, record) {
								return sum + (record.success ? 1 : 0);
							}, 0);
							var total = rec.publicKeys.length;
							info((success === total ? '[SUCCESS] ' : '[FAIL] ') + rec.instance.name + " (" + rec.instance.ipAddress + "): " + success + "/" + total);
						}
						_finish();
					}
				});
			} else {
				warn("No instances found to work on...");
				_finish();
			}
		}
	});

}

exports.handler = onStart;
