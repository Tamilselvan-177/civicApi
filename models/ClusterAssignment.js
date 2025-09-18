const mongoose = require('mongoose');

const clusterAssignmentSchema = new mongoose.Schema({
  clusterId: {
    type: String,
    required: true
  },
  issues: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    required: true
  }],
  department: {
    type: String,
    required: true,
    enum: ['roads', 'water', 'waste', 'electricity', 'parks']
  },
  adminComment: {
    type: String
  },
  status: {
    type: String,
    required: true,
    default: 'In Progress',
    enum: ['Pending', 'In Progress', 'Resolved']
  },
  acknowledgedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  acknowledgedAt: {
    type: Date,
    default: Date.now
  },
  // Track updates and progress
  departmentUpdates: [{
    comment: String,
    status: {
      type: String,
      enum: ['Received', 'Processing', 'Completed', 'Rejected']
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, { timestamps: true });

module.exports = mongoose.model('ClusterAssignment', clusterAssignmentSchema);