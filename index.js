// dependencies
var AWS = require('aws-sdk'),
  fs = require('fs'),
  byline = require('byline'),
  CloudWatchBuddy = require('cloudwatch-buddy');

// Log Group must already exist
var LOG_GROUP = 'patient_access_logs';

// See https://github.com/matthewdfuller/cloudwatch-buddy for details on these options
var cwbOptions = {
  logGroup: LOG_GROUP,
  timeout: 60,
  logFormat: 'string',
  timestampPattern: /\[(.*)\]/,
  timestampFormat: 'DD/MMM/YYYY:HH:mm:ss Z',
  debug: false
};

// get reference to S3 client 
var s3 = new AWS.S3();

exports.handler = function(event, context) {

  var cwbLogs = new CloudWatchBuddy().logs(cwbOptions);
  var srcBucket = event.Records[0].s3.bucket.name;
  // Object key may have spaces or unicode non-ASCII characters.
  var srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
  console.log('Reading: ' + srcBucket + '/' + srcKey);

  var stream = s3.getObject({
    Bucket: srcBucket,
    Key: srcKey
  }).createReadStream();
  stream = byline.createStream(stream);

  stream.on('readable', function() {
    var line;
    while (null !== (line = stream.read())) {
      cwbLogs.log(srcBucket, line.toString());
    }
  });

  stream.on("finish", function () {
    cwbLogs.flush(function() {
      context.done();
    });
  });
};
