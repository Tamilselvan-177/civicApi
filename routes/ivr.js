const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const Complaint = require('../models/Complaint');

const router = express.Router();

// Entry IVR menu
router.post('/voice', (req, res) => {
  const response = new VoiceResponse();

  const gather = response.gather({
    input: 'dtmf speech',
    numDigits: 1,
    action: '/api/ivr/menu',
    method: 'POST'
  });

  gather.say('Welcome to the Civic Issue Reporting System. ' +
             'Press 1 to report an issue. ' +
             'Press 2 to check the status of your issue.');

  // Fallback if no input
  response.say('We did not receive any input. Goodbye!');
  response.hangup();

  res.type('text/xml');
  res.send(response.toString());
});

// Handle IVR menu
router.post('/menu', (req, res) => {
  const digit = req.body.Digits;
  const response = new VoiceResponse();

  if (digit === '1') {
    response.say('Please describe your issue after the beep. Press the pound key when finished.');
    response.record({
      action: '/api/ivr/process-recording',
      method: 'POST',
      maxLength: 30,
      finishOnKey: '#'
    });
  } else if (digit === '2') {
    response.say('Please enter your complaint ID followed by the pound key.');
    response.gather({ 
      input: 'dtmf', 
      finishOnKey: '#', 
      action: '/api/ivr/status', 
      method: 'POST' 
    });
  } else {
    response.say('Invalid choice. Returning to main menu.');
    response.redirect('/api/ivr/voice');
  }

  res.type('text/xml');
  res.send(response.toString());
});

// Process recording
router.post('/process-recording', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl;
    const phoneNumber = req.body.From;
    
    console.log('Received recording:', recordingUrl);
    console.log('From phone number:', phoneNumber);

    // Try to save complaint to database; if DB unavailable, fall back to temp ID
    let complaintIdForResponse = '';
    try {
      const complaint = new Complaint({
        phoneNumber: phoneNumber,
        recordingUrl: recordingUrl,
        description: 'Voice complaint recorded via IVR'
      });
      await complaint.save();
      complaintIdForResponse = complaint.complaintId;
      console.log('Complaint saved with ID:', complaintIdForResponse);
    } catch (dbError) {
      // Fallback: generate a temporary ID so the caller still gets confirmation
      const timestamp = Date.now().toString().slice(-6);
      const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      complaintIdForResponse = 'TMP-' + timestamp + '-' + random;
      console.error('DB save failed, returning temp ID:', complaintIdForResponse, dbError);
    }

    const response = new VoiceResponse();
    response.say('Thank you. Your complaint has been recorded with ID ' + complaintIdForResponse + '. ' +
                 'Please save this ID for future reference. Goodbye!');

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    console.error('Error processing recording:', error);
    const response = new VoiceResponse();
    response.say('Sorry, there was an error processing your complaint. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

// Status check
router.post('/status', async (req, res) => {
  try {
    const complaintId = req.body.Digits;
    console.log('Status check for complaint:', complaintId);

    // Lookup complaint status in database
    const complaint = await Complaint.findOne({ complaintId: complaintId });
    
    const response = new VoiceResponse();
    
    if (complaint) {
      response.say('Complaint ID ' + complaintId + ' is currently ' + complaint.status + '. ' +
                   'It was submitted on ' + complaint.createdAt.toDateString() + '. ' +
                   'Thank you for using our service.');
    } else {
      response.say('Sorry, we could not find a complaint with ID ' + complaintId + '. ' +
                   'Please check your complaint ID and try again.');
    }
    
    response.hangup();

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    console.error('Error checking status:', error);
    const response = new VoiceResponse();
    response.say('Sorry, there was an error checking your complaint status. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

// Webhook for recording status (optional)
router.post('/recording-status', (req, res) => {
  const recordingStatus = req.body.RecordingStatus;
  const recordingSid = req.body.RecordingSid;
  
  console.log('Recording ' + recordingSid + ' status: ' + recordingStatus);
  
  res.status(200).send('OK');
});

module.exports = router;