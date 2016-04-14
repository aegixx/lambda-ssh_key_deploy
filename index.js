// dependencies
var AWS = require('aws-sdk');
var async = require("async");
var util = require('util');
var SSH = require('simple-ssh');

// get reference to AWS resources
var ec2 = new AWS.EC2();
var s3 = new AWS.S3({
	signatureVersion: 'v4'
});

var _TRACE = false;
var _DEBUG = true;
var MASTER_KEY_BUCKET = 'my_bucket';
var DEFAULT_TAG_FILTER = 'auto_assign_keys';
var SSH_USER = 'ec2-user';
var SSH_PORT = 22;

function retrieveS3Object(bucket, key, onDone) {
	if (_TRACE) {
		console.log("TRACE: retrieveS3Object(bucket, key, onDone)", bucket, key);
	}

	if (!bucket) {
		throw "EXCEPTION: retrieveS3Object(...) - 'bucket' parameter is missing."
	}

	if (!key) {
		throw "EXCEPTION: retrieveS3Object(...) - 'key' parameter is missing."
	}

	s3.getObject({
			Bucket: bucket,
			Key: key
		},
		function (err, data) {
			if (err) {
				if (err.code === 'NoSuchKey') {
					if (_DEBUG) {
						console.log("DEBUG: " + err + " (" + bucket + "/" + key + ")");
					}
					onDone();
				} else {
					onDone("retrieveS3Object('" + bucket + "', '" + key + "', onDone) - " + err);
				}
			} else {
				onDone(null, data.Body.toString());
			}
		});
}

function onStart(event, context, onFinish) {
	if (_TRACE) {
		console.log("TRACE: onStart(event, context, onFinish)");
	}

	function _finish(error, success) {
		if (_TRACE) {
			console.log("TRACE: _finish(error, success)", error, success);
		}

		if (error) {
			onFinish("ERROR: " + error);
		} else if (success) {
			onFinish(null, "SUCCESS: " + success);
		} else {
			onFinish();
		}
	};

	function _downloadPublicKeys(records, onDone) {
		if (_TRACE) {
			console.log("TRACE: _downloadPublicKeys(records, onDone)", records);
		}

		function _getBody(item, onDone) {
			if (_TRACE) {
				console.log("TRACE: _getBody(item, onDone)", item);
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

			retrieveS3Object(bucket, key, function (err, body) {
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
		}

		async.map(records, _getBody, function (err, results) {
			if (err) {
				onDone("_downloadS3Objects(records, onDone) :: " + err);
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
				console.log("TRACE: _getInstances(reservation, onDone)", reservation);
			}

			if (!reservation) {
				throw "EXCEPTION: _getInstances(reservation, onComplete) - 'reservation' parameter is missing.";
			}

			function _getInstanceDetail(instance, onDone) {
				if (_TRACE) {
					console.log("TRACE: _getInstanceDetail(instance, onDone)", instance);
				}

				if (!instance) {
					throw "EXCEPTION: _getInstanceDetail(instance, onComplete) - 'instance' parameter is missing.";
				}

				var ipAddress = instance.PrivateIpAddress;
				var instanceName = ipAddress;
				var keyName = instance.KeyName;
				for (var i in instance.Tags) {
					var tag = instance.Tags[i];
					if (tag.Key === 'Name') {
						instanceName = tag.Value;
						break;
					}
				}

				onDone(null, {
					name: instanceName,
					ipAddress: ipAddress,
					keyName: keyName
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
			}],
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
			console.log("TRACE: _syncUsers(record, onDone)", record);
		}

		var instance = record.instance;
		var publicKeys = record.publicKeys;
		var masterKeyBody = record.masterPrivateKeyBody;

		if (!masterKeyBody) {
			console.log('WARN: No master key available for instance ' + instance.name + ' (' + instance.ipAddress + ')');
			onDone(null, record);
		} else if (publicKeys.length > 0) {
			try {
				console.log('INFO: ' + publicKeys.length + ' public key(s) to  deploy...');
				console.log('INFO: Connecting to ' + instance.name + ' (' + instance.ipAddress + ') using master key: ' + instance.keyName);

				var ssh = new SSH({
					host: instance.ipAddress,
					user: SSH_USER,
					port: SSH_PORT,
					key: masterKeyBody
				});

				ssh.on('error', function (err) {
					console.error('ERROR: SSH Failed to connect to ' + instance.name + ' (' + instance.ipAddress + ')', err);
					ssh.end();
					onDone(null, record);
				});

				function _addUsers(onDone) {
					if (_TRACE) {
						console.log("TRACE: _addUsers(onDone)");
					}

					function _queueUserCommand(ssh, publicKey, onExit) {
						if (_TRACE) {
							console.log("TRACE: _queueUserCommand(ssh, publicKey, onExit)", publicKey);
						}

						var action = publicKey.action;
						var username = publicKey.username;
						var keyBody = publicKey.body;

						var cmd = 'echo "' + keyBody + '" | sudo ~/manageUser ' + action + ' ' + username;
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

					ssh.exec('cat > ~/manageUser && chmod +x ~/manageUser', {
						in: fs.readFileSync('manageUser.sh')
					});

					function _commandDone(publicKey, code, stdout, stderr) {
						if (_DEBUG) {
							console.log("DEBUG: SSH Command: " + cmd);
							if (stdout) {
								console.log("DEBUG: SSH (stdout) - " + stdout);
							}
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
								return !rec.success || !rec.fail;
							}, false)) {
							ssh.end();
							onDone();
						}
					}

					for (var i in publicKeys) {
						var publicKey = publicKeys[i];
						_queueUserCommand(ssh, publicKey, _commandDone);
					}

					ssh.start();

				}


			} catch (err) {
				console.error('ERROR: Error while synchronizing ' + instance.name + ' (' + instance.ipAddress + ') - ', err);
				onDone(null, record); // Don't halt
			}
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

			function _downloadMasterKeys(records, onDone) {
				if (_TRACE) {
					console.log("TRACE: _downloadMasterKeys(records, onDone)", records);
				}

				function _getBody(keyName, onDone) {
					if (_TRACE) {
						console.log("TRACE: _getBody(keyName, onDone)", keyName);
					}

					retrieveS3Object(MASTER_KEY_BUCKET, keyName, function (err, body) {
						if (err) {
							onDone("_getBody(keyName, onDone) on '" + MASTER_KEY_BUCKET + "/" + keyName + "' - " + err);
						} else {
							onDone(null, body);
						}
					});
				}

				// Get only unique keys
				var uniqKeyNames = [];
				for (var i in records) {
					var record = records[i];
					if (uniqKeyNames.indexOf(record.instance.keyName) < 0) {
						uniqKeyNames.push(record.instance.keyName);
					}
				}

				async.map(uniqKeyNames, _getBody, function (err, keyBodies) {
					if (err) {
						onDone("_downloadMasterKeys(records, onDone) :: " + err);
					} else {
						for (var i in records) {
							var record = records[i];
							record['masterPrivateKeyBody'] = keyBodies[uniqKeyNames.indexOf(record.instance.keyName)];
						}
						onDone(null, records);
					}
				});
			}

			function _applyToInstances(records, onDone) {
				if (_TRACE) {
					console.log("TRACE: _applyToInstances(records, onDone)", records);
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
			for (var i in instances) {
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
						console.log(publicKeys);
						// var numCompleted = processedRecords.reduce(function (sum, record) {
						// 	return (sum || 0) + (record.isComplete ? 1 : 0);
						// }, 0);
						// console.log("INFO: Successfully synced " + numCompleted + " / " + processedRecords.length + " instance(s)")
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
