const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Post = require("../models/Post");
const ClusterAssignment = require("../models/ClusterAssignment");
const roleAuth = require("../middleware/adminAuth");
require("dotenv").config();

const router = express.Router();

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
 */
router.get("/posts/deduplicate", roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    const posts = await Post.find({ status: "Pending" })
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .lean();

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

      const R = 6371e3;
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
        'roads': ['road', 'pothole', 'street', 'footpath', 'traffic', 'bridge', 'construction'],
        'water': ['water', 'pipe', 'leak', 'drainage', 'sewage', 'flood'],
        'waste': ['garbage', 'waste', 'trash', 'dump', 'cleaning', 'sanitation'],
        'electricity': ['light', 'electricity', 'power', 'streetlight', 'electric', 'wire'],
        'parks': ['park', 'garden', 'tree', 'playground', 'grass', 'recreation']
      };

      const descLower = (description || "").toLowerCase();
      let maxMatches = 0;
      let recommendedDept = 'roads';

      for (const [dept, words] of Object.entries(keywords)) {
        const matches = words.filter(word => descLower.includes(word)).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          recommendedDept = dept;
        }
      }
      return recommendedDept;
    };

    // --- clustering ---
    const clusters = [];
    const processedPosts = new Set();

    for (const post of posts) {
      if (processedPosts.has(post._id.toString())) continue;

      const cluster = {
        mainPost: post,
        issues: [post],
        recommendedDepartment: recommendDepartment(post.description || '')
      };

      for (const otherPost of posts) {
        if (post._id === otherPost._id || processedPosts.has(otherPost._id.toString())) continue;

        const descSim = getDescriptionSimilarity(post.description, otherPost.description);
        const distance = getDistance(post.location?.coordinates, otherPost.location?.coordinates);
        const timeDiff = Math.abs(new Date(post.createdAt) - new Date(otherPost.createdAt)) / (1000*60*60);

        if (descSim > 0.5 && distance < 1000 && timeDiff < 24) {
          cluster.issues.push(otherPost);
          processedPosts.add(otherPost._id.toString());
        }
      }

      if (cluster.issues.length > 1) {
        processedPosts.add(post._id.toString());
        clusters.push(cluster);
      }
    }

    // --- if no real cluster, add dummy ---
    if (clusters.length === 0) {
      clusters.push({
        mainPost: {
          _id: "dummy_main",
          description: "Road damaged near main street",
          location: { type: "Point", coordinates: [80.123, 13.456] },
          createdAt: new Date(),
        },
        recommendedDepartment: "roads",
        issues: [
          {
            _id: "dummy_issue1",
            description: "Huge pothole near bus stop",
            location: { type: "Point", coordinates: [80.123, 13.456] },
            address: "Main Street",
            createdAt: new Date(),
            user: { username: "TestUser" },
            status: "In Progress"
          }
        ]
      });
    } else {
      const issueIds = clusters.flatMap(c => c.issues.map(i => i._id));
      await Post.updateMany(
        { _id: { $in: issueIds } },
        { $set: { status: "In Progress", updatedAt: new Date() } }
      );
      clusters.forEach(c => c.issues.forEach(i => i.status = "In Progress"));
    }

    res.json({
      success: true,
      msg: "Clusters (with In Progress status for testing)",
      clusters: clusters.map(cluster => ({
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
          status: issue.status || "InProgress",
          latitude: issue.location?.coordinates?.[1] || null,
          longitude: issue.location?.coordinates?.[0] || null,
          media: issue.media || [],
          voiceMsg: issue.voiceMsg || null
        }))
      })),
      totalIssues: clusters.reduce((acc, c) => acc + c.issues.length, 0)
    });

  } catch (err) {
    console.error("❌ Error duplicatess posts:", err);
    res.status(500).json({ error: err.message });
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
      type: 'assigned',
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
      model: Post,
      select: "department adminComment status departmentUpdates metrics",
    });

    const formatted = clusters.map((c) => {
      const statusStats = { Pending: 0, "Dept Assigned": 0, "In Progress": 0, Completed: 0 };

      c.issues.forEach((issue) => {
        if (statusStats[issue.status] !== undefined) {
          statusStats[issue.status]++;
        }
      });

      return {
        clusterId: c._id,
        clusterName: c.clusterId, // ✅ schema uses clusterId string
        issues: c.issues,
        stats: statusStats, // ✅ new field for frontend
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching all clusters progress:", err);
    res.status(500).json({ msg: "Server error" });
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
      await Post.updateMany({ _id: { $in: assignment.issues } }, { $set: { status: "Resolved" } });
    } else {
      assignment.status = status;
      await Post.updateMany({ _id: { $in: assignment.issues } }, { $set: { status } });
    }

    await assignment.save();
    res.json(assignment);
  } catch (err) {
    console.error("❌ Error updating cluster assignment:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;