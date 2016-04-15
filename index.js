// dependencies
var AWS = require('aws-sdk');
var async = require("async");
var util = require('util');
var SSH = require('simple-ssh');
var fs = require('fs');

// get reference to AWS resources
var ec2 = new AWS.EC2();
var s3 = new AWS.S3({
	signatureVersion: 'v4'
});

var _TRACE = false;
var _DEBUG = false;
var MASTER_KEY_BUCKET = 'acme-master-keys';

var DEFAULT_TAG_FILTER = 'auto_assign_keys'; // Set this tag to 'true' to enable automatic deployment of users/keys
var DEFAULT_SSH_USER = 'ec2-user';  // Override for each instance by setting the 'auto_assign_ssh_user' tag
var DEFAULT_SSH_PORT = 22; // Override for each instance by setting the 'auto_assign_ssh_port' tag

function onStart(event, context, onFinish) {
	if (_TRACE) {
		console.log("TRACE: onStart(event, context, onFinish)", util.inspect(event, {depth: 5}));
	}

	function _retrieveS3Object(bucket, key, onDone) {
		if (_TRACE) {
			console.log("TRACE: _retrieveS3Object('" + bucket + "', '" + key + "', onDone)");
		}

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
						console.log("WARN: " + err + " (" + bucket + "/" + key + ")");
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
		if (_TRACE) {
			console.log("TRACE: _finish('" + error + "', '" + success + "')");
		}

		if (error) {
			onFinish("ERROR: " + error);
		} else if (success) {
			onFinish(null, "SUCCESS: " + success);
		} else {
			onFinish();
		}
	}

	function _downloadPublicKeys(records, onDone) {
		if (_TRACE) {
			console.log("TRACE: _downloadPublicKeys(records, onDone)");
		}

		function _getBody(item, onDone) {
			if (_TRACE) {
				console.log("TRACE: _getBody(item, onDone)");
			}

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
		if (_TRACE) {
			console.log("TRACE: _getEC2Instances(onDone)");
		}

		function _getInstances(reservation, onDone) {
			if (_TRACE) {
				console.log("TRACE: _getInstances(reservation, onDone)");
			}

			if (!reservation) {
				throw "EXCEPTION: _getInstances(reservation, onComplete) - 'reservation' parameter is missing.";
			}

			function _getInstanceDetail(instance, onDone) {
				if (_TRACE) {
					console.log("TRACE: _getInstanceDetail(instance, onDone)");
				}

				if (!instance) {
					throw "EXCEPTION: _getInstanceDetail(instance, onComplete) - 'instance' parameter is missing.";
				}

				var ipAddress = instance.PrivateIpAddress;
				var instanceName = ipAddress;
				var keyName = instance.KeyName;
				var sshPort = DEFAULT_SSH_PORT;
				var sshUser = DEFAULT_SSH_USER;
				for (var i = 0; i < instance.Tags.length; i++) {
					var tag = instance.Tags[i];
					if (tag.Key === 'Name') {
						instanceName = tag.Value;
					}
					if (tag.Key === 'auto_assign_ssh_port') {
						sshPort = tag.Value;
					}
					if(tag.Key === 'auto_assign_ssh_user') {
						sshUser = tag.Value;
					}
				}

				onDone(null, {
					name: instanceName,
					ipAddress: ipAddress,
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
				Name: 'tag:' + DEFAULT_TAG_FILTER,
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
		if (_TRACE) {
			console.log("TRACE: _syncUsers(record, onDone)");
		}

		var instance = record.instance;
		var publicKeys = record.publicKeys;
		var masterKeyBody = record.masterPrivateKeyBody;

		if (!masterKeyBody) {
			console.log('WARN: No master key available for instance ' + instance.name + ' (' + instance.ipAddress + ')');
			onDone(null, record);
		} else if (publicKeys.length > 0) {
			if (_DEBUG) {
				console.log('DEBUG: Connecting to ' + instance.name + ' (' + instance.sshUser + '@' + instance.ipAddress + ':' + instance.sshPort + ') using master key: ' + instance.keyName);
			}

			var ssh = new SSH({
				host: instance.ipAddress,
				user: instance.sshUser,
				port: instance.sshPort,
				key: masterKeyBody
			});

			ssh.on('error', function (err) {
				console.error('ERROR: SSH Failed to connect to ' + instance.name + ' (' + instance.sshUser + '@' + instance.ipAddress + ':' + instance.sshPort + ')', err);
				ssh.end();
				onDone(null, record);
			});

			function _queueUserCommand(ssh, publicKey, onExit) {
				if (_TRACE) {
					console.log("TRACE: _queueUserCommand(ssh, publicKey, onExit) - " + publicKey.action + " :: " + publicKey.username);
				}

				var action = publicKey.action;
				var username = publicKey.username;
				var keyBody = publicKey.body;

				var cmd = null;
				if (action === 'add') {
					cmd = 'echo "' + keyBody + '" | sudo ~/manageUser ' + action + ' ' + username;
				} else {
					cmd = 'sudo ~/manageUser ' + action + ' ' + username;
				}
				if (_DEBUG) {
					console.log("DEBUG: Queueing SSH Command: " + cmd);
				}
				ssh.exec(cmd, {
					pty: true,
					exit: function (code, stdout, stderr) {
						onExit(publicKey, code, stdout, stderr);
					}
				});

			}

			function _commandDone(publicKey, code, stdout, stderr) {
				if (_DEBUG && stdout) {
					console.log("DEBUG: SSH (stdout) - " + stdout);
				}
				if (stderr) {
					console.log("WARN: SSH (stderr) - " + stderr);
				}
				if (_DEBUG) {
					console.log("DEBUG: SSH exit code: " + code);
				}

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
				in: fs.readFileSync('manageUser.sh')
			});

			for (var i = 0; i < publicKeys.length; i++) {
				var publicKey = publicKeys[i];
				_queueUserCommand(ssh, publicKey, _commandDone);
			}

			ssh.start();
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

			console.log("INFO: " + publicKeys.length + " public key(s) to update on " + instances.length + " instance(s)");

			function _downloadMasterKeys(records, onDone) {
				if (_TRACE) {
					console.log("TRACE: _downloadMasterKeys(records, onDone)");
				}

				function _getBody(keyName, onDone) {
					if (_TRACE) {
						console.log("TRACE: _getBody('" + keyName + "', onDone)");
					}

					_retrieveS3Object(MASTER_KEY_BUCKET, keyName, function (err, body) {
						if (err) {
							onDone("_getBody(keyName, onDone) on '" + MASTER_KEY_BUCKET + "/" + keyName + "' - " + err);
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
				if (_TRACE) {
					console.log("TRACE: _applyToInstances(records, onDone)");
				}

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
				records.push({
					instance: instance,
					publicKeys: publicKeys
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
							console.log("INFO: " + (success === total ? '[SUCCESS] ' : '[FAIL] ') + rec.instance.name + " (" + rec.instance.ipAddress + "): " + success + "/" + total);
						}
						_finish();
					}
				});
			} else {
				console.log("WARN: No instances found to work on...");
				_finish();
			}
		}
	});

}

exports.handler = onStart;
