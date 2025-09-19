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
  
  // New fields for enhanced functionality
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  priorityReason: {
    type: String
  },
  prioritySetBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  prioritySetAt: {
    type: Date
  },
  
  // Estimated completion date
  estimatedCompletionDate: {
    type: Date
  },
  actualCompletionDate: {
    type: Date
  },
  
  // Resource allocation
  assignedTeam: [{
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    memberName: String,
    role: String,
    assignedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Enhanced tracking
  departmentUpdates: [{
    comment: String,
    status: {
      type: String,
      enum: ['Pending', 'In Progress', 'Resolved']
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    updateType: {
      type: String,
      enum: ['status_change', 'progress_update', 'resource_request', 'completion', 'note'],
      default: 'progress_update'
    },
    attachments: [{
      filename: String,
      url: String,
      type: String // image, document, etc.
    }],
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Notes system
  notes: [{
    content: {
      type: String,
      required: true
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    isInternal: {
      type: Boolean,
      default: false // false = visible to citizens, true = internal only
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Location and impact
  impactArea: {
    type: String, // e.g., "residential", "commercial", "industrial"
    enum: ['residential', 'commercial', 'industrial', 'mixed', 'public']
  },
  estimatedAffectedPeople: {
    type: Number,
    default: 0
  },
  urgencyLevel: {
    type: Number,
    min: 1,
    max: 10,
    default: 5
  },
  
  // Budget and resources
  estimatedCost: {
    amount: Number,
    currency: {
      type: String,
      default: 'INR'
    }
  },
  actualCost: {
    amount: Number,
    currency: {
      type: String,
      default: 'INR'
    }
  },
  budgetApproved: {
    type: Boolean,
    default: false
  },
  
  // Citizen feedback
  citizenFeedback: [{
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post'
    },
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: String,
    submittedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Performance metrics
  metrics: {
    responseTime: {
      type: Number // in hours
    },
    resolutionTime: {
      type: Number // in hours
    },
    citizenSatisfactionScore: {
      type: Number,
      min: 0,
      max: 10
    },
    efficiencyScore: {
      type: Number,
      min: 0,
      max: 100
    }
  },
  
  // Workflow status
  workflowStage: {
    type: String,
    enum: ['assessment', 'planning', 'resource_allocation', 'execution', 'testing', 'completion', 'feedback'],
    default: 'assessment'
  },
  
  // Integration with external systems
  externalReferences: [{
    system: String, // e.g., "municipal_system", "contractor_portal"
    referenceId: String,
    url: String
  }],
  
  // Automated reminders and alerts
  reminderSettings: {
    enabled: {
      type: Boolean,
      default: true
    },
    intervals: [{
      type: String,
      enum: ['24h', '48h', '72h', '1week']
    }],
    lastReminderSent: Date
  }
  
}, { 
  timestamps: true,
  // Add indexes for better query performance
  index: {
    status: 1,
    department: 1,
    priority: 1,
    createdAt: -1,
    acknowledgedBy: 1
  }
});

// Virtual fields
clusterAssignmentSchema.virtual('isOverdue').get(function() {
  if (this.status === 'Resolved') return false;
  const daysSinceCreation = (new Date() - this.createdAt) / (1000 * 60 * 60 * 24);
  return daysSinceCreation > 3; // Consider overdue after 3 days
});

clusterAssignmentSchema.virtual('totalIssues').get(function() {
  return this.issues ? this.issues.length : 0;
});

clusterAssignmentSchema.virtual('averageRating').get(function() {
  if (!this.citizenFeedback || this.citizenFeedback.length === 0) return null;
  const total = this.citizenFeedback.reduce((sum, feedback) => sum + feedback.rating, 0);
  return (total / this.citizenFeedback.length).toFixed(1);
});

// Middleware to calculate metrics before saving
clusterAssignmentSchema.pre('save', function(next) {
  // Calculate response time (time from creation to first department update)
  if (this.departmentUpdates && this.departmentUpdates.length > 0 && !this.metrics.responseTime) {
    const firstUpdate = this.departmentUpdates[0];
    this.metrics.responseTime = (firstUpdate.updatedAt - this.createdAt) / (1000 * 60 * 60); // hours
  }
  
  // Calculate resolution time if status is resolved
  if (this.status === 'Resolved' && !this.metrics.resolutionTime) {
    this.metrics.resolutionTime = (this.updatedAt - this.createdAt) / (1000 * 60 * 60); // hours
    this.actualCompletionDate = new Date();
  }
  
  // Calculate citizen satisfaction score
  if (this.citizenFeedback && this.citizenFeedback.length > 0) {
    const avgRating = this.citizenFeedback.reduce((sum, f) => sum + f.rating, 0) / this.citizenFeedback.length;
    this.metrics.citizenSatisfactionScore = (avgRating / 5) * 10; // Convert to 0-10 scale
  }
  
  next();
});

// Instance methods
clusterAssignmentSchema.methods.addUpdate = function(updateData) {
  this.departmentUpdates.push({
    ...updateData,
    updatedAt: new Date()
  });
  return this.save();
};

clusterAssignmentSchema.methods.setPriority = function(priority, reason, userId) {
  this.priority = priority;
  this.priorityReason = reason;
  this.prioritySetBy = userId;
  this.prioritySetAt = new Date();
  return this.save();
};

clusterAssignmentSchema.methods.addNote = function(content, authorId, isInternal = false) {
  this.notes.push({
    content,
    author: authorId,
    isInternal,
    createdAt: new Date()
  });
  return this.save();
};

// Static methods
clusterAssignmentSchema.statics.getAnalytics = function(filters = {}) {
  return this.aggregate([
    { $match: filters },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgResolutionTime: { $avg: '$metrics.resolutionTime' },
        avgSatisfactionScore: { $avg: '$metrics.citizenSatisfactionScore' }
      }
    }
  ]);
};

clusterAssignmentSchema.statics.getDepartmentPerformance = function(department, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        department,
        createdAt: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalAssignments: { $sum: 1 },
        resolvedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'Resolved'] }, 1, 0] }
        },
        avgResolutionTime: { $avg: '$metrics.resolutionTime' },
        avgSatisfactionScore: { $avg: '$metrics.citizenSatisfactionScore' }
      }
    }
  ]);
};

// Ensure virtual fields are serialized
clusterAssignmentSchema.set('toJSON', { virtuals: true });
clusterAssignmentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ClusterAssignment', clusterAssignmentSchema);