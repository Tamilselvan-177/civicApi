const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Post = require("../models/Post");
const ClusterAssignment = require("../models/ClusterAssignment");
const roleAuth = require("../middleware/adminAuth");
const DeviceToken = require("../models/DeviceToken");
const natural = require("natural");

const router = express.Router();
const { Expo } = require("expo-server-sdk");
const expo = new Expo();
require("dotenv").config();

const priorityKeywords = {
  high: ["fallen", "tree", "open", "manhole", "accident", "danger", "fire", "injury"],
  medium: ["pothole", "malfunction", "leakage", "overflow", "streetlight", "traffic"],
  low: ["graffiti", "dumping", "sidewalk", "minor"]
};
const tokenizer = new natural.WordTokenizer();

// Function to get numeric priority
function getPriorityScore(text) {
  const tokens = tokenizer.tokenize((text || "").toLowerCase());
  if (tokens.some(token => priorityKeywords.high.includes(token))) return 1; // High
  if (tokens.some(token => priorityKeywords.medium.includes(token))) return 2; // Medium
  return 3; // Low
}
// Fetch posts and rank
async function getHighestPriorityPosts(limit = 10) {
  const posts = await Post.find().lean();

  posts.forEach(post => {
    post.nlpPriority = getPriorityScore(post.description);
  });

  posts.sort((a, b) => a.nlpPriority - b.nlpPriority || new Date(a.createdAt) - new Date(b.createdAt));

  return posts.slice(0, limit);
}

// Usage
getHighestPriorityPosts(20).then(posts => console.log(posts));

// helper function to send push
async function sendPushNotification(tokens, title, body) {
  let messages = [];
  for (let pushToken of tokens) {
    if (!Expo.isExpoPushToken(pushToken)) continue;
    messages.push({
      to: pushToken,
      sound: "default",
      title,
      body,
      data: { screen: "ClusterDetails", extra: { cluster: true } }
    });
  }

  const chunks = expo.chunkPushNotifications(messages);
  for (let chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      console.error("❌ Error sending push:", error);
    }
  }
}

/**
 * 🔑 Login route for all roles (admin, superadmin, department)
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email (any role)
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    // Sign JWT with actual role from DB
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1y" }
    );

    res.json({
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
    console.log(err);
  }
});

/**
 * 👤 Profile route (any logged-in role)
 */
router.get("/me", roleAuth(["admin", "superadmin", "department"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/**
 * 📝 Get deduplicated/clustered posts
 * Accessible by: admin, superadmin
 * FIXED: No automatic status updates - only return clusters for review
 */
router.get("/posts/deduplicate", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    // Only get truly pending posts (not already processed)
    const posts = await Post.find({ 
      status: "Pending",
      clusterAssignment: { $exists: false } // Exclude posts already in clusters
    })
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .lean();

    console.log(`📊 Found ${posts.length} pending posts for clustering`);

    // --- helpers ---
    const getDescriptionSimilarity = (desc1, desc2) => {
      const words1 = (desc1 || "").toLowerCase().split(/\W+/);
      const words2 = (desc2 || "").toLowerCase().split(/\W+/);
      const overlap = words1.filter(word => words2.includes(word)).length;
      return overlap / Math.max(words1.length, words2.length || 1);
    };

    const getDistance = (coords1, coords2) => {
      if (!coords1 || !coords2) return Infinity;
      const [lon1, lat1] = coords1;
      const [lon2, lat2] = coords2;
      if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;

      const R = 6371e3; // Earth's radius in meters
      const φ1 = lat1 * Math.PI/180;
      const φ2 = lat2 * Math.PI/180;
      const Δφ = (lat2-lat1) * Math.PI/180;
      const Δλ = (lon2-lon1) * Math.PI/180;

      const a = Math.sin(Δφ/2) ** 2 +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    const recommendDepartment = (description) => {
      const keywords = {
        'roads': ['road', 'pothole', 'street', 'footpath', 'traffic', 'bridge', 'construction', 'highway', 'pavement'],
        'water': ['water', 'pipe', 'leak', 'drainage', 'sewage', 'flood', 'tap', 'supply', 'overflow'],
        'waste': ['garbage', 'waste', 'trash', 'dump', 'cleaning', 'sanitation', 'litter', 'rubbish'],
        'electricity': ['light', 'electricity', 'power', 'streetlight', 'electric', 'wire', 'outage', 'transformer'],
        'parks': ['park', 'garden', 'tree', 'playground', 'grass', 'recreation', 'bench', 'greenery']
      };

      const descLower = (description || "").toLowerCase();
      let maxMatches = 0;
      let recommendedDept = 'roads'; // default

      for (const [dept, words] of Object.entries(keywords)) {
        const matches = words.filter(word => descLower.includes(word)).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          recommendedDept = dept;
        }
      }
      return recommendedDept;
    };

    // --- clustering algorithm ---
    const clusters = [];
    const processedPosts = new Set();

    for (const post of posts) {
      if (processedPosts.has(post._id.toString())) continue;

      const cluster = {
        mainPost: post,
        issues: [post],
        recommendedDepartment: recommendDepartment(post.description || ''),
        similarityScores: [] // for debugging
      };

      // Find similar posts
      for (const otherPost of posts) {
        if (post._id.equals(otherPost._id) || processedPosts.has(otherPost._id.toString())) continue;

        const descSimilarity = getDescriptionSimilarity(post.description, otherPost.description);
        const distance = getDistance(post.location?.coordinates, otherPost.location?.coordinates);
        const timeDiff = Math.abs(new Date(post.createdAt) - new Date(otherPost.createdAt)) / (1000*60*60); // hours

        // Clustering criteria: similar description + close location + recent time
        const isSimilar = descSimilarity > 0.4 && distance < 1000 && timeDiff < 48; // 48 hours window

        if (isSimilar) {
          cluster.issues.push(otherPost);
          cluster.similarityScores.push({
            postId: otherPost._id,
            descSimilarity: descSimilarity.toFixed(2),
            distance: Math.round(distance),
            timeDiff: Math.round(timeDiff)
          });
          processedPosts.add(otherPost._id.toString());
        }
      }

      // Only include clusters with multiple issues
      if (cluster.issues.length > 1) {
        processedPosts.add(post._id.toString());
        clusters.push(cluster);
        console.log(`📊 Created cluster with ${cluster.issues.length} issues for department: ${cluster.recommendedDepartment}`);
      }
    }

    // ❌ REMOVED: No automatic status updates here
    // Posts remain "Pending" until explicitly acknowledged

    console.log(`📊 Found ${clusters.length} clusters from ${posts.length} pending posts`);

    // Format response for frontend
    const formattedClusters = clusters.map(cluster => ({
      mainPost: {
        id: cluster.mainPost._id,
        description: cluster.mainPost.description,
        location: cluster.mainPost.location,
        createdAt: cluster.mainPost.createdAt
      },
      recommendedDepartment: cluster.recommendedDepartment,
      issues: cluster.issues.map(issue => ({
        id: issue._id,
        description: issue.description,
        location: issue.location,
        address: issue.address,
        createdAt: issue.createdAt,
        userName: issue.user?.username || "Anonymous",
        status: issue.status || "Pending", // Keep original status
        latitude: issue.location?.coordinates?.[1] || null,
        longitude: issue.location?.coordinates?.[0] || null,
        media: issue.media || [],
        voiceMsg: issue.voiceMsg || null
      }))
    }));

    res.json({
      success: true,
      message: `Found ${clusters.length} issue clusters ready for review`,
      clusters: formattedClusters,
      totalIssues: clusters.reduce((acc, c) => acc + c.issues.length, 0),
      pendingPosts: posts.length
    });

  } catch (err) {
    console.error("❌ Error clustering posts:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to cluster posts",
      message: err.message 
    });
  }
});

// 📌 Acknowledge cluster (Admin / Superadmin)
router.post("/posts/acknowledge-cluster", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    const { clusterId, issues, adminComment, department, status } = req.body;

    // Validate enum status
    const allowedStatuses = ["Pending", "In Progress", "Resolved"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}` });
    }

    const clusterAssignment = new ClusterAssignment({
      clusterId,
      issues,
      department,
      adminComment,
      status,
      acknowledgedBy: req.user.id,
      departmentUpdates: [{
        status: "In Progress",
        comment: "Issue forwarded to department"
      }]
    });

    await clusterAssignment.save();

    // Update all related posts
    await Post.updateMany(
      { _id: { $in: issues } },
      {
        $set: {
          status: status,
          clusterAssignment: clusterAssignment._id,
          updatedAt: new Date()
        }
      }
    );

    // 🔔 Find which users created these issues
    const posts = await Post.find({ _id: { $in: issues } }).select("createdBy");
    const userIds = posts.map(p => p.createdBy);

    // 🔔 Get tokens of those users
    const tokensDocs = await DeviceToken.find({ userId: { $in: userIds } });
    const tokens = tokensDocs.map(t => t.token);

    if (tokens.length > 0) {
      await sendPushNotification(
        tokens,
        "📢 Cluster Acknowledged",
        `Your issue(s) in Cluster #${clusterId} have been forwarded to ${department}`
      );
    }

    res.json({
      msg: "Cluster acknowledged, users notified, and forwarded to department",
      department,
      updatedIssues: issues.length,
      clusterAssignmentId: clusterAssignment._id
    });
  } catch (err) {
    console.error("❌ Error acknowledging cluster:", err);
    res.status(500).json({ error: err.message });
  }
});
/**
 * 📊 Enhanced Stats Route - More accurate counting
 */
router.get("/posts/stats", async (req, res) => {
  try {
    console.log("📊 Calculating post statistics...");

    // Get accurate counts
    const [pending, inProgress, resolved, totalReports] = await Promise.all([
      Post.countDocuments({ status: "Pending" }),
      Post.countDocuments({ status: "In Progress" }),
      Post.countDocuments({ status: "Resolved" }),
      Post.countDocuments({}) // Total count
    ]);

    // Additional insights
    const [clusteredCount, recentCount, overdueCount] = await Promise.all([
      Post.countDocuments({ clusterAssignment: { $exists: true } }),
      Post.countDocuments({ 
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
      }),
      Post.countDocuments({
        status: { $ne: "Resolved" },
        createdAt: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
      })
    ]);

    const stats = {
      pending,
      inProgress,
      resolved,
      totalReports,
      // Additional metrics
      clustered: clusteredCount,
      recent: recentCount, // Last 7 days
      overdue: overdueCount, // Older than 3 days, not resolved
      resolutionRate: totalReports > 0 ? ((resolved / totalReports) * 100).toFixed(1) : 0
    };

    console.log("📊 Stats calculated:", stats);

    res.json({
      success: true,
      ...stats,
      lastUpdated: new Date()
    });

  } catch (err) {
    console.error("❌ Error calculating stats:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to calculate statistics",
      message: err.message
    });
  }
});
// Add these routes to your existing admin router (after the existing routes)

/**
 * 📊 Dashboard Analytics - Advanced metrics and insights
 * Accessible by: department, admin, superadmin
 */
router.get("/dashboard-analytics", roleAuth(["department", "admin", "superadmin"]), async (req, res) => {
  try {
    const currentDate = new Date();
    const lastWeek = new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all assignments
    const allAssignments = await ClusterAssignment.find()
      .populate("issues")
      .populate("acknowledgedBy", "username email")
      .lean();

    const allPosts = await Post.find().lean();

    // Calculate summary statistics
    const summary = {
      totalAssignments: allAssignments.length,
      resolvedCount: allAssignments.filter(a => a.status === 'Resolved').length,
      inProgressCount: allAssignments.filter(a => a.status === 'In Progress').length,
      pendingCount: allAssignments.filter(a => a.status === 'Pending').length,
      highPriorityCount: allAssignments.filter(a => 
        a.status !== 'Resolved' && 
        (currentDate - new Date(a.createdAt)) / (1000 * 60 * 60 * 24) > 3
      ).length
    };

    // Calculate weekly comparison
    const lastWeekAssignments = allAssignments.filter(a => new Date(a.createdAt) >= lastWeek);
    const lastWeekResolved = allAssignments.filter(a => 
      a.status === 'Resolved' && new Date(a.updatedAt) >= lastWeek
    );
    
    summary.assignmentChange = calculatePercentageChange(
      allAssignments.length,
      allAssignments.length - lastWeekAssignments.length
    );
    summary.assignmentTrend = summary.assignmentChange >= 0 ? 'up' : 'down';

    summary.resolvedChange = calculatePercentageChange(
      summary.resolvedCount,
      summary.resolvedCount - lastWeekResolved.length
    );
    summary.resolvedTrend = summary.resolvedChange >= 0 ? 'up' : 'down';

    // Calculate average resolution time
    const resolvedAssignments = allAssignments.filter(a => a.status === 'Resolved');
    const avgResolutionTime = resolvedAssignments.length > 0 
      ? resolvedAssignments.reduce((acc, assignment) => {
          const resolutionTime = (new Date(assignment.updatedAt) - new Date(assignment.createdAt)) / (1000 * 60 * 60);
          return acc + resolutionTime;
        }, 0) / resolvedAssignments.length
      : 0;

    summary.avgResolutionTime = Math.round(avgResolutionTime);
    summary.resolutionTimeChange = 5; // You can calculate this based on historical data
    summary.resolutionTimeTrend = 'down'; // Assuming improvement

    // Calculate efficiency score (resolution rate + speed factor)
    const resolutionRate = summary.totalAssignments > 0 
      ? (summary.resolvedCount / summary.totalAssignments) * 100 
      : 0;
    
    const speedFactor = avgResolutionTime > 0 
      ? Math.max(0, 100 - (avgResolutionTime / 24) * 10) // Penalty for long resolution times
      : 50;

    summary.efficiencyScore = Math.round((resolutionRate * 0.7) + (speedFactor * 0.3));

    // Generate trends data (last 30 days)
    const trends = generateTrendData(allAssignments, 30);

    // Generate performance data
    const performance = {
      weeklyData: generateWeeklyPerformanceData(allAssignments),
      responseTimeData: generateResponseTimeData(allAssignments)
    };

    // Category breakdown
    const categoryBreakdown = generateCategoryBreakdown(allPosts);
    summary.categoryBreakdown = categoryBreakdown;

    // Recent activity
    const recentActivity = generateRecentActivity(allAssignments, allPosts);

    res.json({
      success: true,
      summary,
      trends,
      performance,
      recentActivity
    });

  } catch (err) {
    console.error("❌ Error fetching dashboard analytics:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📈 Department Performance Report
 * Generates detailed performance reports
 */
router.get("/performance-report", roleAuth(["department", "admin", "superadmin"]), async (req, res) => {
  try {
    const { startDate, endDate, department } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    let query = {
      createdAt: { $gte: start, $lte: end }
    };

    if (department && department !== 'all') {
      query.department = department;
    }

    const assignments = await ClusterAssignment.find(query)
      .populate("issues")
      .populate("acknowledgedBy", "username email")
      .lean();

    // Generate comprehensive report
    const report = {
      period: { start, end },
      totalAssignments: assignments.length,
      byStatus: {
        resolved: assignments.filter(a => a.status === 'Resolved').length,
        inProgress: assignments.filter(a => a.status === 'In Progress').length,
        pending: assignments.filter(a => a.status === 'Pending').length
      },
      avgResolutionTime: calculateAverageResolutionTime(assignments),
      topPerformers: getTopPerformers(assignments),
      departmentBreakdown: getDepartmentBreakdown(assignments),
      issuesByCategory: getCategoryAnalysis(assignments),
      resolutionTrends: generateResolutionTrends(assignments),
      recommendations: generateRecommendations(assignments)
    };

    res.json({
      success: true,
      report,
      generatedAt: new Date()
    });

  } catch (err) {
    console.error("❌ Error generating performance report:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🎯 Set Priority for Assignment
 * Allows setting priority levels for assignments
 */
/**
 * 🔔 Get Notifications for Department
 * Returns department-specific notifications
 */
router.get("/notifications", roleAuth(["department"]), async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Get overdue assignments
    const overdueAssignments = await ClusterAssignment.find({
      status: { $ne: 'Resolved' },
      createdAt: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } // 3 days old
    }).limit(parseInt(limit));

    // Get recently assigned
    const recentAssignments = await ClusterAssignment.find({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
    }).limit(parseInt(limit));

    // Get high priority items
    const highPriorityAssignments = await ClusterAssignment.find({
      priority: { $in: ['high', 'critical'] },
      status: { $ne: 'Resolved' }
    }).limit(parseInt(limit));

    const notifications = [
      ...overdueAssignments.map(assignment => ({
        id: assignment._id,
        type: 'overdue',
        title: 'Overdue Assignment',
        message: `Assignment #${assignment._id.toString().slice(-8)} is overdue`,
        priority: 'high',
        createdAt: assignment.createdAt,
        assignmentId: assignment._id
      })),
      ...recentAssignments.map(assignment => ({
        id: assignment._id,
        type: 'new_assignment',
        title: 'New Assignment',
        message: `New assignment #${assignment._id.toString().slice(-8)} received`,
        priority: 'medium',
        createdAt: assignment.createdAt,
        assignmentId: assignment._id
      })),
      ...highPriorityAssignments.map(assignment => ({
        id: assignment._id,
        type: 'high_priority',
        title: 'High Priority Assignment',
        message: `High priority assignment #${assignment._id.toString().slice(-8)} requires attention`,
        priority: 'critical',
        createdAt: assignment.createdAt,
        assignmentId: assignment._id
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
     .slice(0, parseInt(limit));

    res.json({
      success: true,
      notifications,
      unreadCount: notifications.filter(n => n.priority === 'critical').length
    });

  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({ error: err.message });
  }
});

// Helper functions
function calculatePercentageChange(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

function generateTrendData(assignments, days) {
  const trends = [];
  const currentDate = new Date();
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(currentDate);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    
    const dayAssignments = assignments.filter(assignment => {
      const assignmentDate = new Date(assignment.createdAt).toISOString().split('T')[0];
      return assignmentDate === dateStr;
    });
    
    trends.push({
      date: dateStr,
      resolved: dayAssignments.filter(a => a.status === 'Resolved').length,
      pending: dayAssignments.filter(a => a.status === 'Pending').length,
      inProgress: dayAssignments.filter(a => a.status === 'In Progress').length
    });
  }
  
  return trends;
}

function generateWeeklyPerformanceData(assignments) {
  const weeks = [];
  const currentDate = new Date();
  
  for (let i = 4; i >= 0; i--) {
    const weekStart = new Date(currentDate);
    weekStart.setDate(weekStart.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    
    const weekAssignments = assignments.filter(assignment => {
      const assignmentDate = new Date(assignment.createdAt);
      return assignmentDate >= weekStart && assignmentDate <= weekEnd;
    });
    
    weeks.push({
      week: `Week ${5 - i}`,
      assigned: weekAssignments.length,
      resolved: weekAssignments.filter(a => a.status === 'Resolved').length,
      pending: weekAssignments.filter(a => a.status === 'Pending').length
    });
  }
  
  return weeks;
}

function generateResponseTimeData(assignments) {
  const days = [];
  const currentDate = new Date();
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date(currentDate);
    date.setDate(date.getDate() - i);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short' });
    
    const dayAssignments = assignments.filter(assignment => {
      const assignmentDate = new Date(assignment.createdAt);
      return assignmentDate.toDateString() === date.toDateString();
    });
    
    const avgResponseTime = dayAssignments.length > 0 
      ? dayAssignments.reduce((acc, assignment) => {
          const responseTime = assignment.departmentUpdates.length > 0 
            ? (new Date(assignment.departmentUpdates[0].updatedAt) - new Date(assignment.createdAt)) / (1000 * 60 * 60)
            : 24; // Default to 24 hours if no response yet
          return acc + responseTime;
        }, 0) / dayAssignments.length
      : 0;
    
    days.push({
      day: dateStr,
      avgResponseTime: Math.round(avgResponseTime * 10) / 10
    });
  }
  
  return days;
}

function generateCategoryBreakdown(posts) {
  const categories = {
    'roads': 0,
    'water': 0,
    'waste': 0,
    'electricity': 0,
    'parks': 0
  };
  
  posts.forEach(post => {
    const description = (post.description || '').toLowerCase();
    
    if (description.includes('road') || description.includes('pothole') || description.includes('street')) {
      categories.roads++;
    } else if (description.includes('water') || description.includes('pipe') || description.includes('leak')) {
      categories.water++;
    } else if (description.includes('garbage') || description.includes('waste') || description.includes('trash')) {
      categories.waste++;
    } else if (description.includes('light') || description.includes('electricity') || description.includes('power')) {
      categories.electricity++;
    } else if (description.includes('park') || description.includes('garden') || description.includes('tree')) {
      categories.parks++;
    } else {
      categories.roads++; // Default category
    }
  });
  
  return Object.entries(categories).map(([category, count]) => ({
    category: category.charAt(0).toUpperCase() + category.slice(1),
    count
  }));
}

function generateRecentActivity(assignments, posts) {
  const activities = [];
  
  // Recent assignments
  const recentAssignments = assignments
    .filter(assignment => new Date(assignment.createdAt) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    .slice(0, 5);
    
  recentAssignments.forEach(assignment => {
    activities.push({
      type: 'In Progress',
      message: `New assignment #${assignment._id.toString().slice(-8)} received`,
      timestamp: assignment.createdAt
    });
  });
  
  // Recent resolutions
  const recentResolved = assignments
    .filter(assignment => 
      assignment.status === 'Resolved' && 
      new Date(assignment.updatedAt) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    )
    .slice(0, 5);
    
  recentResolved.forEach(assignment => {
    activities.push({
      type: 'resolved',
      message: `Assignment #${assignment._id.toString().slice(-8)} resolved successfully`,
      timestamp: assignment.updatedAt
    });
  });
  
  return activities
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);
}

function calculateAverageResolutionTime(assignments) {
  const resolved = assignments.filter(a => a.status === 'Resolved');
  if (resolved.length === 0) return 0;
  
  const totalTime = resolved.reduce((acc, assignment) => {
    return acc + (new Date(assignment.updatedAt) - new Date(assignment.createdAt));
  }, 0);
  
  return Math.round((totalTime / resolved.length) / (1000 * 60 * 60)); // Hours
}

function getTopPerformers(assignments) {
  const performers = {};
  
  assignments.forEach(assignment => {
    if (assignment.acknowledgedBy) {
      const performerId = assignment.acknowledgedBy._id || assignment.acknowledgedBy;
      if (!performers[performerId]) {
        performers[performerId] = {
          id: performerId,
          name: assignment.acknowledgedBy.username || 'Unknown',
          resolved: 0,
          total: 0
        };
      }
      
      performers[performerId].total++;
      if (assignment.status === 'Resolved') {
        performers[performerId].resolved++;
      }
    }
  });
  
  return Object.values(performers)
    .map(p => ({ ...p, rate: p.total > 0 ? (p.resolved / p.total) * 100 : 0 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
}

function getDepartmentBreakdown(assignments) {
  const departments = {};
  
  assignments.forEach(assignment => {
    const dept = assignment.department || 'unknown';
    if (!departments[dept]) {
      departments[dept] = { resolved: 0, total: 0 };
    }
    
    departments[dept].total++;
    if (assignment.status === 'Resolved') {
      departments[dept].resolved++;
    }
  });
  
  return Object.entries(departments).map(([name, stats]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    ...stats,
    rate: stats.total > 0 ? (stats.resolved / stats.total) * 100 : 0
  }));
}

function getCategoryAnalysis(assignments) {
  // This would analyze the types of issues in assignments
  // For now, return mock data
  return [
    { category: 'Infrastructure', count: assignments.length * 0.4 },
    { category: 'Maintenance', count: assignments.length * 0.3 },
    { category: 'Emergency', count: assignments.length * 0.2 },
    { category: 'Others', count: assignments.length * 0.1 }
  ];
}

function generateResolutionTrends(assignments) {
  // Generate weekly resolution trends
  const weeks = 4;
  const trends = [];
  
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    
    const weekAssignments = assignments.filter(a => {
      const date = new Date(a.createdAt);
      return date >= weekStart && date <= weekEnd;
    });
    
    trends.push({
      week: `Week ${weeks - i}`,
      resolved: weekAssignments.filter(a => a.status === 'Resolved').length,
      total: weekAssignments.length
    });
  }
  
  return trends;
}

function generateRecommendations(assignments) {
  const recommendations = [];
  
  // Analyze assignment patterns and generate recommendations
  const pendingCount = assignments.filter(a => a.status === 'Pending').length;
  const overdueCount = assignments.filter(a => 
    a.status !== 'Resolved' && 
    (new Date() - new Date(a.createdAt)) / (1000 * 60 * 60 * 24) > 3
  ).length;
  
  if (pendingCount > assignments.length * 0.3) {
    recommendations.push({
      type: 'warning',
      title: 'High Pending Rate',
      message: 'Consider increasing response capacity or redistributing workload'
    });
  }
  
  if (overdueCount > 0) {
    recommendations.push({
      type: 'urgent',
      title: 'Overdue Assignments',
      message: `${overdueCount} assignments are overdue and need immediate attention`
    });
  }
  
  const avgResolutionTime = calculateAverageResolutionTime(assignments);
  if (avgResolutionTime > 48) {
    recommendations.push({
      type: 'improvement',
      title: 'Resolution Time',
      message: 'Average resolution time is above 48 hours. Consider process optimization'
    });
  }
  
  return recommendations;
}

// 📌 Get all cluster assignments (Department only)
router.get("/cluster-assignments", roleAuth(["department"]), async (req, res) => {
  try {
    const assignments = await ClusterAssignment.find()
      .populate("issues")
      .populate("acknowledgedBy", "username email")
      .sort({ createdAt: -1 })
      .lean();

    res.json(assignments);
  } catch (err) {
    console.error("❌ Error fetching cluster assignments:", err);
    res.status(500).json({ error: err.message });
  }
});




// Add this route to your existing router file or create a new posts.js route file

/**
 * 📱 Get community feed - posts with 5+ likes
 */
router.get("/community-feed", async (req, res) => {
  try {
    const communityPosts = await Post.aggregate([
      // Join likes
      {
        $lookup: {
          from: "likes",
          localField: "_id",
          foreignField: "post",
          as: "likes",
        },
      },
      // Join comments
      {
        $lookup: {
          from: "comments",
          localField: "_id",
          foreignField: "post",
          as: "comments",
        },
      },
      // Join post author info
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      // Add counts
      {
        $addFields: {
          likeCount: { $size: "$likes" },
          commentCount: { $size: "$comments" },
        },
      },
      // Filter posts with >= 3 likes
      {
        $match: {
          likeCount: { $gte: 2 },
        },
      },
      // Sort by likeCount desc, then createdAt desc
      {
        $sort: { likeCount: -1, createdAt: -1 },
      },
      // Limit to 50
      { $limit: 50 },
      // Project final structure
      {
        $project: {
          _id: 1,
          description: 1,
          voiceMsg: 1,
          media: 1,
          location: 1,
          status: 1,
          createdAt: 1,
          likeCount: 1,
          commentCount: 1,
          user: {
            _id: { $arrayElemAt: ["$userInfo._id", 0] },
            username: { $arrayElemAt: ["$userInfo.username", 0] },
            email: { $arrayElemAt: ["$userInfo.email", 0] },
          },
          // Only comment text and createdAt
          recentComments: {
            $slice: [
              {
                $map: {
                  input: "$comments",
                  as: "comment",
                  in: {
                    text: "$$comment.text",
                    createdAt: "$$comment.createdAt",
                  },
                },
              },
              2,
            ],
          },
        },
      },
    ]);

    res.json({
      success: true,
      count: communityPosts.length,
      posts: communityPosts,
    });
  } catch (err) {
    console.error("Community feed error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch community feed",
      message: err.message,
    });
  }
});

// 📌 Acknowledge cluster (Admin / Superadmin)
router.post("/posts/acknowledge-cluster", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    const { clusterId, issues, adminComment, department, status } = req.body;

    // Validate enum status
    const allowedStatuses = ["Pending", "In Progress", "Resolved"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}` });
    }

    const clusterAssignment = new ClusterAssignment({
      clusterId,
      issues,
      department,
      adminComment,
      status,
      acknowledgedBy: req.user.id,
      departmentUpdates: [{
        status: "In Progress",
        comment: "Issue forwarded to department"
      }]
    });

    await clusterAssignment.save();

    // Update all related posts
    await Post.updateMany(
      { _id: { $in: issues } },
      {
        $set: {
          status: status,
          clusterAssignment: clusterAssignment._id,
          updatedAt: new Date()
        }
      }
    );

    res.json({
      msg: "Cluster acknowledged and forwarded to department",
      department,
      updatedIssues: issues.length,
      clusterAssignmentId: clusterAssignment._id
    });
  } catch (err) {
    console.error("❌ Error acknowledging cluster:", err);
    res.status(500).json({ error: err.message });
  }
});
// 📌 Get all posts (Admin and Superadmin)
router.get("/posts/all", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    const posts = await Post.find()
      .populate("user", "username email")
      .populate("clusterAssignment")
      .sort({ createdAt: -1 })
      .lean();

    const formattedPosts = posts.map((post) => ({
      ...post,
      userId: post.user?._id || null,
      userName: post.user?.username || "Unknown",
      userEmail: post.user?.email || ""
    }));

    res.json(formattedPosts);
  } catch (err) {
    console.error("❌ Error fetching admin posts:", err);
    res.status(500).json({ error: err.message });
  }
});
// Get all clusters + their issues + status stats
router.get("/clusters/progress", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    const clusters = await ClusterAssignment.find().populate({
      path: "issues",
      model: "Post",
      select: "title department adminComment status departmentUpdates metrics", // ✅ populate title
    });

    const formatted = clusters.map((c) => {
      const statusStats = { Pending: 0, "Dept Assigned": 0, "In Progress": 0, Resolved: 0 };

      c.issues.forEach((issue) => {
        // normalize "Completed" or "Resolved"
        const normalizedStatus = issue.status === "Completed" ? "Resolved" : issue.status;
        if (statusStats[normalizedStatus] !== undefined) {
          statusStats[normalizedStatus]++;
        }
      });

      return {
        clusterId: c._id,
        clusterName: c.clusterId, // schema uses clusterId string
        issues: c.issues.map((issue) => ({
          _id: issue._id,
          title: issue.title || "Unnamed Issue", // ✅ send title for frontend
          department: issue.department,
          adminComment: issue.adminComment,
          status: issue.status,
        })),
        stats: statusStats, // stats for frontend
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching all clusters progress:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

// API: Get all posts with NLP priority and sort
router.get("/posts/nlp", async (req, res) => {
  try {
    const posts = await Post.find().lean();

    // Add NLP priority
    posts.forEach(post => {
      post.nlpPriority = getPriorityScore(post.description);
    });

    // Sort by priority (1=High) then by creation time
    posts.sort((a, b) =>
      a.nlpPriority - b.nlpPriority ||
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// API: Get only high-priority posts
router.get("/posts/high-priority", async (req, res) => {
  try {
    const posts = await Post.find().lean();

    // Filter only high-priority posts
    const highPriorityPosts = posts.filter(
      post => getPriorityScore(post.description) === 1
    );

    // Sort by createdAt (latest first)
    highPriorityPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(highPriorityPosts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


/**
 * 👍 Toggle like on a post
 */
router.post("/:postId/like", roleAuth(["admin", "superadmin", "department"]), async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    // Check if post exists
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, msg: "Post not found" });
    }

    // Check if user already liked this post
    const existingLike = await Like.findOne({ user: userId, post: postId });

    if (existingLike) {
      // Unlike - remove the like
      await Like.findOneAndDelete({ user: userId, post: postId });
      
      // Get updated like count
      const likeCount = await Like.countDocuments({ post: postId });
      
      res.json({
        success: true,
        liked: false,
        likeCount,
        message: "Post unliked"
      });
    } else {
      // Like - add new like
      const newLike = new Like({ user: userId, post: postId });
      await newLike.save();
      
      // Get updated like count
      const likeCount = await Like.countDocuments({ post: postId });
      
      res.json({
        success: true,
        liked: true,
        likeCount,
        message: "Post liked"
      });
    }

  } catch (err) {
    console.error("Like toggle error:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to toggle like",
      message: err.message 
    });
  }
});


router.patch("/cluster-assignments/:id/priority", roleAuth(["department", "admin", "superadmin"]), async (req, res) => {
  try {
    const { priority, reason } = req.body;
    
    if (!['low', 'medium', 'high', 'critical'].includes(priority)) {
      return res.status(400).json({ error: "Invalid priority level" });
    }

    const assignment = await ClusterAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ msg: "Assignment not found" });
    }

    assignment.priority = priority;
    assignment.priorityReason = reason;
    assignment.prioritySetBy = req.user.id;
    assignment.prioritySetAt = new Date();

    await assignment.save();

    res.json({
      success: true,
      msg: "Priority updated successfully",
      assignment
    });

  } catch (err) {
    console.error("❌ Error updating priority:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📝 Add Assignment Note
 * Allows adding internal notes to assignments
 */
router.post("/cluster-assignments/:id/notes", roleAuth(["department", "admin", "superadmin"]), async (req, res) => {
  try {
    const { note, isInternal = false } = req.body;

    const assignment = await ClusterAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ msg: "Assignment not found" });
    }

    if (!assignment.notes) {
      assignment.notes = [];
    }

    assignment.notes.push({
      content: note,
      author: req.user.id,
      isInternal,
      createdAt: new Date()
    });

    await assignment.save();

    res.json({
      success: true,
      msg: "Note added successfully",
      assignment
    });

  } catch (err) {
    console.error("❌ Error adding note:", err);
    res.status(500).json({ error: err.message });
  }
});


// 📌 Get cluster assignment details (Department / Admin / Superadmin)
router.get("/cluster-assignments/:id", roleAuth(["department", "admin", "superadmin"]), async (req, res) => {
  try {
    const assignment = await ClusterAssignment.findById(req.params.id)
      .populate("issues")
      .populate("acknowledgedBy", "username email")
      .lean();

    if (!assignment) return res.status(404).json({ msg: "Cluster assignment not found" });

    res.json(assignment);
  } catch (err) {
    console.error("❌ Error fetching cluster assignment:", err);
    res.status(500).json({ error: err.message });
  }
});
// 🔄 Update cluster assignment status (Department only)
router.patch("/cluster-assignments/:id", roleAuth(["department"]), async (req, res) => {
  try {
    const { status, comment } = req.body;
    const assignment = await ClusterAssignment.findById(req.params.id);

    if (!assignment) return res.status(404).json({ msg: "Cluster assignment not found" });

    // Add department update
    assignment.departmentUpdates.push({ status, comment, updatedAt: new Date() });

    // Update assignment & related posts
    if (status === "Resolved") {
      assignment.status = "Resolved";
      await Post.updateMany(
        { _id: { $in: assignment.issues } },
        { $set: { status: "Resolved" } }
      );
    } else {
      assignment.status = status;
      await Post.updateMany(
        { _id: { $in: assignment.issues } },
        { $set: { status } }
      );
    }

    await assignment.save();

    // 🔔 Notify all users who reported issues in this cluster
    const posts = await Post.find({ _id: { $in: assignment.issues } }).select("createdBy");
    const userIds = posts.map(p => p.createdBy);

    const tokensDocs = await DeviceToken.find({ userId: { $in: userIds } });
    const tokens = tokensDocs.map(t => t.token);

    if (tokens.length > 0) {
      await sendPushNotification(
        tokens,
        `Cluster #${assignment.clusterId} Update`,
        `The status of your reported issues is now: ${status}`
      );
    }

    res.json(assignment);
  } catch (err) {
    console.error("❌ Error updating cluster assignment:", err);
    res.status(500).json({ error: err.message });
  } 
});



module.exports = router;