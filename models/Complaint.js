const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
  complaintId: { 
    type: String, 
    unique: true, 
    required: true 
  },
  phoneNumber: { 
    type: String, 
    required: true 
  },
  recordingUrl: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String 
  },
  status: { 
    type: String, 
    enum: ['pending', 'in-progress', 'resolved', 'closed'], 
    default: 'pending' 
  },
  priority: { 
    type: String, 
    enum: ['low', 'medium', 'high', 'urgent'], 
    default: 'medium' 
  },
  category: { 
    type: String, 
    enum: ['infrastructure', 'safety', 'environment', 'other'], 
    default: 'other' 
  },
  assignedTo: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  notes: [{ 
    type: String 
  }]
}, { timestamps: true });

complaintSchema.pre('save', function(next) {
  if (!this.complaintId) {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    this.complaintId = 'CIV-' + timestamp + '-' + random;
  }
  next();
});

module.exports = mongoose.model('Complaint', complaintSchema);