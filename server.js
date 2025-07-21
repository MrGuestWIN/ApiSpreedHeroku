import express from 'express';
import axios from 'axios';
import fs from 'fs';

// Built-in random string generator (fallback if randomUtils.js not available)
function generateRandomString(length, type) {
  let chars = '';
  switch (type) {
    case 'alphanumeric':
      chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      break;
    case 'uppercase':
      chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      break;
    case 'lowercase':
      chars = 'abcdefghijklmnopqrstuvwxyz';
      break;
    case 'numeric':
      chars = '0123456789';
      break;
    default:
      chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  }
  
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Default config (fallback if config.json not available)
const config = {
  subjectTemplate: "Hello {email} - ID: {randomID:7}",
  fromName: "TWF5aWxlciA8bm9yZXBseUBnbWFpbC5jb20+", // Base64 encoded
  deleteSentEmails: false
};

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Google Drive file ID untuk smtp.txt (ubah sesuai file Anda)
const GOOGLE_DRIVE_FILE_ID = process.env.SMTP_FILE_ID || 'YOUR_GOOGLE_DRIVE_FILE_ID';

// Cache untuk WebApp URLs
let cachedWebAppUrls = [];
let lastFetch = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

// Global stats with usage tracking per WebApp
let globalStats = {
  totalSent: 0,
  totalFailed: 0,
  webAppLimitReached: new Set(),
  webAppUsageCount: new Map(), // Track usage per WebApp index
  lastReset: new Date(),
  dailyLimit: 1400 // emails per WebApp per day
};

// Function to fetch smtp.txt from Google Drive
async function fetchWebAppUrlsFromDrive() {
  try {
    const now = Date.now();
    
    // Return cached if still valid
    if (cachedWebAppUrls.length > 0 && (now - lastFetch) < CACHE_DURATION) {
      return cachedWebAppUrls;
    }

    // Fetch from Google Drive (public file)
    const driveUrl = `https://drive.google.com/uc?export=download&id=${GOOGLE_DRIVE_FILE_ID}`;
    const response = await axios.get(driveUrl, { timeout: 10000 });
    
    const urls = response.data
      .split('\n')
      .map(url => url.trim())
      .filter(url => url && url.startsWith('https://'));
    
    if (urls.length === 0) {
      throw new Error('No valid WebApp URLs found in Google Drive file');
    }

    // Update cache
    cachedWebAppUrls = urls;
    lastFetch = now;
    
    console.log(`✅ Loaded ${urls.length} WebApp URLs from Google Drive`);
    return urls;
    
  } catch (error) {
    console.error('❌ Error fetching WebApp URLs from Google Drive:', error.message);
    
    // Fallback to local file if exists
    try {
      if (fs.existsSync('smtp.txt')) {
        const localData = fs.readFileSync('smtp.txt', 'utf-8');
        const urls = localData.split('\n').map(url => url.trim()).filter(url => url);
        console.log('⚠️ Using local smtp.txt as fallback');
        return urls;
      }
    } catch (localError) {
      console.error('❌ Local fallback also failed:', localError.message);
    }
    
    throw new Error('Failed to load WebApp URLs from both Google Drive and local file');
  }
}

// Function to decode base64 from name
function decodeFromName(encodedStr) {
  try {
    const cleanedStr = encodedStr.replace(/^=\?us-ascii\?B\?/, '').replace(/\?=$/, '');
    return Buffer.from(cleanedStr, 'base64').toString('utf-8');
  } catch (error) {
    return encodedStr; // Return original if decode fails
  }
}

// Reset rate limits and usage counters daily
function resetDailyLimits() {
  const now = new Date();
  const lastReset = globalStats.lastReset;
  
  // Reset if it's a new day
  if (now.getDate() !== lastReset.getDate() || 
      now.getMonth() !== lastReset.getMonth() || 
      now.getFullYear() !== lastReset.getFullYear()) {
    
    globalStats.webAppLimitReached.clear();
    globalStats.webAppUsageCount.clear(); // Reset usage counters
    globalStats.lastReset = now;
    console.log('🔄 Daily rate limits and usage counters reset');
  }
}

// Smart load balancing: select WebApp with least usage
function selectOptimalWebApp(webAppUrls) {
  // Get available WebApps (not rate limited)
  const availableIndices = [];
  
  for (let i = 0; i < webAppUrls.length; i++) {
    if (!globalStats.webAppLimitReached.has(i)) {
      const currentUsage = globalStats.webAppUsageCount.get(i) || 0;
      
      // Check if WebApp is near limit (90% threshold)
      if (currentUsage < globalStats.dailyLimit * 0.9) {
        availableIndices.push(i);
      }
    }
  }

  if (availableIndices.length === 0) {
    return null; // No available WebApps
  }

  // Sort by usage count (ascending) to get least used WebApp
  availableIndices.sort((a, b) => {
    const usageA = globalStats.webAppUsageCount.get(a) || 0;
    const usageB = globalStats.webAppUsageCount.get(b) || 0;
    return usageA - usageB;
  });

  const selectedIndex = availableIndices[0];
  return {
    index: selectedIndex,
    url: webAppUrls[selectedIndex],
    currentUsage: globalStats.webAppUsageCount.get(selectedIndex) || 0
  };
}

// Update WebApp usage after successful send
function updateWebAppUsage(webAppIndex, success = true) {
  if (success) {
    const currentUsage = globalStats.webAppUsageCount.get(webAppIndex) || 0;
    const newUsage = currentUsage + 1;
    globalStats.webAppUsageCount.set(webAppIndex, newUsage);
    
    // Check if WebApp reached limit
    if (newUsage >= globalStats.dailyLimit) {
      globalStats.webAppLimitReached.add(webAppIndex);
      console.log(`⚠️ WebApp #${webAppIndex + 1} reached daily limit (${newUsage}/${globalStats.dailyLimit})`);
    }
    
    console.log(`📊 WebApp #${webAppIndex + 1} usage: ${newUsage}/${globalStats.dailyLimit} (${((newUsage/globalStats.dailyLimit)*100).toFixed(1)}%)`);
  }
}

// Main email endpoint
app.get('/email', async (req, res) => {
  try {
    resetDailyLimits();
    
    const { to, subject, from } = req.query;

    // Validate required parameters
    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Parameter "to" (email address) is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Get WebApp URLs from Google Drive
    const webAppUrls = await fetchWebAppUrlsFromDrive();
    
    // Smart selection of optimal WebApp
    const selectedWebApp = selectOptimalWebApp(webAppUrls);

    if (!selectedWebApp) {
      return res.status(429).json({
        success: false,
        error: 'All WebApps have reached their daily limit or are near capacity. Try again tomorrow.',
        nextReset: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        webAppStats: Array.from(globalStats.webAppUsageCount.entries()).map(([index, usage]) => ({
          webAppIndex: index + 1,
          usage: usage,
          limit: globalStats.dailyLimit,
          percentage: `${((usage/globalStats.dailyLimit)*100).toFixed(1)}%`
        }))
      });
    }

    // Generate dynamic subject if not provided
    let dynamicSubject = subject;
    if (!subject) {
      const randomID = generateRandomString(7, 'alphanumeric');
      const randomUppercase = generateRandomString(5, 'uppercase');
      const randomLowercase = generateRandomString(4, 'lowercase');
      const randomNumber = generateRandomString(10, 'numeric');

      dynamicSubject = config.subjectTemplate
        .replace(/{email}/g, to)
        .replace(/{randomID:\d+}/g, randomID)
        .replace(/{randomUppercase:\d+}/g, randomUppercase)
        .replace(/{randomLowercase:\d+}/g, randomLowercase)
        .replace(/{randomNumber:\d+}/g, randomNumber);
    }

    // Prepare from name
    const fromName = from || decodeFromName(config.fromName);

    // Send email via selected WebApp
    try {
      await axios.get(selectedWebApp.url, {
        params: {
          to: to,
          from: fromName,
          subject: dynamicSubject,
        },
        timeout: 30000,
        validateStatus: (status) => status < 500 // Don't throw on 4xx errors
      });

      // Update success stats and usage
      globalStats.totalSent++;
      updateWebAppUsage(selectedWebApp.index, true);

      console.log(`✅ Email sent to ${to} via WebApp #${selectedWebApp.index + 1} (Usage: ${selectedWebApp.currentUsage + 1}/${globalStats.dailyLimit})`);

      // Return success response
      return res.json({
        success: true,
        message: 'Email sent successfully',
        data: {
          to: to,
          subject: dynamicSubject,
          from: fromName,
          webAppUsed: selectedWebApp.index + 1,
          webAppUsage: selectedWebApp.currentUsage + 1,
          webAppLimit: globalStats.dailyLimit,
          timestamp: new Date().toISOString()
        },
        stats: {
          totalSent: globalStats.totalSent,
          totalFailed: globalStats.totalFailed,
          availableApps: webAppUrls.length - globalStats.webAppLimitReached.size,
          rateLimitedApps: globalStats.webAppLimitReached.size
        }
      });

    } catch (error) {
      // Handle rate limiting
      if (error.response && error.response.status === 429) {
        globalStats.webAppLimitReached.add(selectedWebApp.index);
        updateWebAppUsage(selectedWebApp.index, false);
        console.log(`⚠️ WebApp #${selectedWebApp.index + 1} hit rate limit unexpectedly`);
        
        return res.status(429).json({
          success: false,
          error: `WebApp #${selectedWebApp.index + 1} rate limit reached`,
          availableApps: webAppUrls.length - globalStats.webAppLimitReached.size - 1
        });
      } else {
        globalStats.totalFailed++;
        console.error(`❌ Failed to send to ${to}:`, error.message);
        
        return res.status(500).json({
          success: false,
          error: 'Failed to send email',
          details: error.response?.data || error.message
        });
      }
    }

  } catch (error) {
    console.error('🚨 API Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Bulk email endpoint with smart distribution
app.post('/bulk', async (req, res) => {
  try {
    const { emails, subject, from } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Parameter "emails" must be a non-empty array'
      });
    }

    if (emails.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 500 emails per batch request'
      });
    }

    resetDailyLimits();
    const webAppUrls = await fetchWebAppUrlsFromDrive();
    
    // Smart distribution of emails across WebApps
    const distribution = distributeEmailsAcrossWebApps(emails, webAppUrls);
    
    if (distribution.length === 0) {
      return res.status(429).json({
        success: false,
        error: 'All WebApps are at capacity',
        webAppStats: getWebAppUsageStats()
      });
    }

    const results = [];
    let successCount = 0;
    let failureCount = 0;

    // Process each WebApp's assigned emails
    for (const { webAppIndex, webAppUrl, assignedEmails } of distribution) {
      console.log(`📦 Processing ${assignedEmails.length} emails via WebApp #${webAppIndex + 1}`);
      
      for (const email of assignedEmails) {
        try {
          // Generate dynamic subject if not provided
          let dynamicSubject = subject;
          if (!subject) {
            const randomID = generateRandomString(7, 'alphanumeric');
            const randomUppercase = generateRandomString(5, 'uppercase');
            const randomLowercase = generateRandomString(4, 'lowercase');
            const randomNumber = generateRandomString(10, 'numeric');

            dynamicSubject = config.subjectTemplate
              .replace(/{email}/g, email)
              .replace(/{randomID:\d+}/g, randomID)
              .replace(/{randomUppercase:\d+}/g, randomUppercase)
              .replace(/{randomLowercase:\d+}/g, randomLowercase)
              .replace(/{randomNumber:\d+}/g, randomNumber);
          }

          const fromName = from || decodeFromName(config.fromName);

          await axios.get(webAppUrl, {
            params: {
              to: email,
              from: fromName,
              subject: dynamicSubject,
            },
            timeout: 30000
          });

          // Update usage and stats
          updateWebAppUsage(webAppIndex, true);
          globalStats.totalSent++;
          successCount++;
          
          results.push({
            email: email,
            status: 'sent',
            webApp: webAppIndex + 1,
            timestamp: new Date().toISOString()
          });

          console.log(`✅ Sent: ${email} via WebApp #${webAppIndex + 1}`);
          
          // Small delay between sends
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          if (error.response && error.response.status === 429) {
            globalStats.webAppLimitReached.add(webAppIndex);
            console.log(`⚠️ WebApp #${webAppIndex + 1} hit rate limit during bulk send`);
          }
          
          globalStats.totalFailed++;
          failureCount++;
          
          results.push({
            email: email,
            status: 'failed',
            error: error.response?.data?.error || error.message,
            webApp: webAppIndex + 1,
            timestamp: new Date().toISOString()
          });

          console.log(`❌ Failed: ${email} via WebApp #${webAppIndex + 1}`);
        }
      }
    }

    res.json({
      success: true,
      message: 'Bulk email process completed',
      summary: {
        total: emails.length,
        sent: successCount,
        failed: failureCount,
        successRate: `${((successCount / emails.length) * 100).toFixed(1)}%`
      },
      distribution: distribution.map(d => ({
        webApp: d.webAppIndex + 1,
        emailsAssigned: d.assignedEmails.length,
        currentUsage: globalStats.webAppUsageCount.get(d.webAppIndex) || 0,
        limit: globalStats.dailyLimit
      })),
      results: results
    });

  } catch (error) {
    console.error('🚨 Bulk Email Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Function to distribute emails across WebApps optimally
function distributeEmailsAcrossWebApps(emails, webAppUrls) {
  const distribution = [];
  let emailIndex = 0;

  // Get available WebApps sorted by usage (least used first)
  const availableWebApps = [];
  for (let i = 0; i < webAppUrls.length; i++) {
    if (!globalStats.webAppLimitReached.has(i)) {
      const currentUsage = globalStats.webAppUsageCount.get(i) || 0;
      const remainingCapacity = globalStats.dailyLimit - currentUsage;
      
      if (remainingCapacity > 0) {
        availableWebApps.push({
          index: i,
          url: webAppUrls[i],
          currentUsage: currentUsage,
          remainingCapacity: remainingCapacity
        });
      }
    }
  }

  // Sort by remaining capacity (highest first) for optimal distribution
  availableWebApps.sort((a, b) => b.remainingCapacity - a.remainingCapacity);

  // Distribute emails evenly across available WebApps
  for (const webApp of availableWebApps) {
    if (emailIndex >= emails.length) break;

    const emailsToAssign = Math.min(
      webApp.remainingCapacity,
      Math.ceil((emails.length - emailIndex) / availableWebApps.length)
    );

    if (emailsToAssign > 0) {
      const assignedEmails = emails.slice(emailIndex, emailIndex + emailsToAssign);
      
      distribution.push({
        webAppIndex: webApp.index,
        webAppUrl: webApp.url,
        assignedEmails: assignedEmails,
        currentUsage: webApp.currentUsage,
        remainingCapacity: webApp.remainingCapacity
      });

      emailIndex += emailsToAssign;
    }
  }

  return distribution;
}

// Get WebApp usage statistics
function getWebAppUsageStats() {
  const stats = [];
  for (const [index, usage] of globalStats.webAppUsageCount.entries()) {
    stats.push({
      webApp: index + 1,
      usage: usage,
      limit: globalStats.dailyLimit,
      percentage: `${((usage/globalStats.dailyLimit)*100).toFixed(1)}%`,
      remaining: globalStats.dailyLimit - usage,
      isLimited: globalStats.webAppLimitReached.has(index)
    });
  }
  return stats;
}

// Stats endpoint with detailed WebApp usage
app.get('/stats', async (req, res) => {
  try {
    const webAppUrls = await fetchWebAppUrlsFromDrive();
    const webAppStats = getWebAppUsageStats();
    
    res.json({
      success: true,
      stats: {
        totalSent: globalStats.totalSent,
        totalFailed: globalStats.totalFailed,
        totalWebApps: webAppUrls.length,
        availableApps: webAppUrls.length - globalStats.webAppLimitReached.size,
        rateLimitedApps: globalStats.webAppLimitReached.size,
        dailyLimit: globalStats.dailyLimit,
        uptime: Math.floor(process.uptime()),
        lastReset: globalStats.lastReset,
        cacheStatus: {
          urlsCached: cachedWebAppUrls.length,
          lastFetch: new Date(lastFetch).toISOString()
        },
        webAppDetails: webAppStats.length > 0 ? webAppStats : 'No usage data yet'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stats',
      details: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Kawus Email API is running',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Manual rate limit reset (for admin)
app.post('/reset', (req, res) => {
  globalStats.webAppLimitReached.clear();
  globalStats.webAppUsageCount.clear();
  globalStats.lastReset = new Date();
  
  res.json({
    success: true,
    message: 'Rate limits and usage counters manually reset',
    timestamp: new Date().toISOString()
  });
});

// Refresh WebApp URLs cache
app.post('/refresh', async (req, res) => {
  try {
    cachedWebAppUrls = [];
    lastFetch = 0;
    
    const urls = await fetchWebAppUrlsFromDrive();
    
    res.json({
      success: true,
      message: 'WebApp URLs cache refreshed',
      urlsLoaded: urls.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to refresh cache',
      details: error.message
    });
  }
});

// Root endpoint - API documentation
app.get('/', (req, res) => {
  res.json({
    message: 'Kawus Email API v2.0',
    author: 'MrGuest404',
    endpoints: {
      'GET /email': 'Send single email - Params: to (required), subject (optional), from (optional)',
      'POST /bulk': 'Send bulk emails - Body: { emails: [], subject: "", from: "" }',
      'GET /stats': 'Get API statistics',
      'GET /health': 'Health check',
      'POST /reset': 'Reset rate limits (admin)',
      'POST /refresh': 'Refresh WebApp URLs cache'
    },
    examples: {
      'Single email': 'GET /email?to=test@example.com&subject=Hello&from=Sender',
      'Bulk email': 'POST /bulk with {"emails": ["test1@example.com"], "subject": "Hello"}'
    },
    limits: {
      'Single request': '1 email per request',
      'Bulk request': 'Max 100 emails per batch',
      'Daily limit': 'Depends on WebApp quotas (typically 100-1500 per WebApp)'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Kawus Email API v2.0 running on port ${PORT}`);
  console.log(`📧 API URL: http://localhost:${PORT}`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  
  // Initial load of WebApp URLs
  fetchWebAppUrlsFromDrive().catch(console.error);
});
