var busboy = require('connect-busboy');
var AWS = require('aws-sdk')
var uuid = require('node-uuid');
var errors = require('./errors');
var streamBuffers = require('stream-buffers');

const uploadBucket = 'mockup-gem-uploaded-images'
// 4 MB
const maxFileSize = 4000000

const imageUploadMiddleware = busboy({
 immediate: true,
 limits: {
  files: 1,
  fileSize: maxFileSize
 }
});

/* I'm gonna apologize in advance for this code. If it seems overly complicated,
   keep in mind that it achieves these goals:
    1) Validate all form fields are present before allowing the image to be uploaded.
    2) Stream the file upload directly to S3 (we don't have to buffer in memory any
       more than the normal amount of buffering that streams do.)
   Accomplishing both these goals while working with raw streams required some
   surprisingly complex code.
*/
function imageUploadHandler(req, res) {
 var overlay_image_found = false;
 var mockup_name_found = false;

 /* If we make it to the end of the stream and don't have all the required fields
    then we reject the request.
 */
 req.busboy.on('finish', handleEndOfRequest);
 function handleEndOfRequest() {
  if (overlay_image_found === false || mockup_name_found === false) {
   return res.send(errors.invalidUploadRequestError());
  }
  return res.send();
 }

 /* This promise won't resolve until all required fields have been validated at
    which point we can unpause the file upload stream and allow them to continue
    uploading. If the fields are invalid, it will reject and the file upload
    will be canceled.
 */
 const awaitMockupName = new Promise(waitForMockupName);
 function waitForMockupName(resolve, reject) {
  req.busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
   if (fieldname === 'mockup_name') {
    mockup_name_found = true;
    return resolve(val);
   } else {
    return reject();
   }
  });
 }

 /* This function will handle file upload events. Internally, it creates a new
    stream that buffers the file upload until we've resolved that all the
    required fields are present. Once that is determined, it will begin streaming
    the file upload to S3.
 */
 req.busboy.on('file', handleImageUpload);
 function handleImageUpload(fieldName, file, filename, encoding, mimetype) {
  if (fieldName !== 'overlay_image') {
   return res.send(errors.invalidUploadFieldError());
  }

  overlay_image_found = true;

  var imageUploadBuffer = new streamBuffers.ReadableStreamBuffer();
  imageUploadBuffer.pause();
  // Pipe the file upload stream into our buffer
  file.on('data', function(data) {
   imageUploadBuffer.put(data);
  });

  /* Once we have finished streaming the file, stop the buffer or the AWS SDK
     will keep waiting for more data to upload to S3.
  */
  file.on('end', function() {
   imageUploadBuffer.stop();
  });

  /* Wait for all the required fields before unpausing the stream and sending
     it to S3.
  */
  awaitMockupName
   .then(streamToS3)
   .catch(function(e) {
    console.log(e);
    return res.send(errors.invalidUploadRequestError());
   });

  function streamToS3(mockup_name) {
   // Resume the buffer since we've validated all the fields and want the data
   imageUploadBuffer.resume();
   var s3obj = new AWS.S3({
    params: {
     Bucket: uploadBucket,
     Key: getS3ImageKey(mockup_name, filename),
    }
   });

   // Connect the file stream directly to S3 SDK so upload is streamed instead
   // of being batched in memory.
   s3obj.upload({Body: imageUploadBuffer}, function(err, data) {
    if (err) {
     return res.send(errors.uploadFailedError());
    }
    console.log(data);
   });
  }
 }
}

function getS3ImageKey(mockup_name, filename) {
 const splitFilename = filename.split('.');
 // Currently ignoring their original file extension but may be useful later.
 const originalFileExtension = splitFilename.length >= 2 ? splitFilename.pop() : 'unknown';
 const imageUuid = uuid.v4();
 return `${imageUuid}-${mockup_name}-${originalFileExtension}`;
}

module.exports = {
 imageUploadMiddleware: imageUploadMiddleware,
 imageUploadHandler: imageUploadHandler
}
