var deploy = require('./index');
var config = require ('./config');
var fs = require('fs');


var eventFile = process.argv[2];
var event = null;
if (eventFile) {
	// Process single event
	event = JSON.parse(fs.readFileSync(eventFile).toString());
	return processEvent(event);
} else {
	// Process all public keys in bucket

	var AWS = require('aws-sdk');
	if (config.aws) {
		AWS.config.update(config.aws);
	}
	var s3 = new AWS.S3({
		signatureVersion: 'v4'
	});

	s3.listObjects({
		Bucket: config.userKeyBucket
	}, function(err, data) {
		if (err) {
			console.error('ERROR: ' + err);
			return -1;
		} else {
			var event = {
				Records: []
			};

			for (var i = 0; i < data.Contents.length; i++) {
				var obj = data.Contents[i];
				if (!obj.Key.match(/id_rsa.pub$/)) {
					continue;
				}

				event.Records.push({
					s3: {
						object: {
							eTag: obj.ETag,
							key: obj.Key,
							size: obj.Size
						},
						bucket: {
							arn: "arn:aws:s3:::" + config.userKeyBucket,
							name: config.userKeyBucket
						}
					},
					eventName: "ObjectCreated:Put",
					eventSource: "aws:s3"
				});
			}

			return processEvent(event);
		}
	});
}

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