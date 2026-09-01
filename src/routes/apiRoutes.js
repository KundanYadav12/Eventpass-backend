const express = require('express');
const router = express.Router();

// Middlewares
const { authenticateToken, optionalAuth } = require('../middleware/authMiddleware');
const { requireRole, requirePermission, scopeEventAccess } = require('../middleware/rbacMiddleware');
const { authLimiter, scanLimiter } = require('../middleware/rateLimiter');

// Controllers
const authController = require('../controllers/authController');
const eventController = require('../controllers/eventController');
const dashboardController = require('../controllers/dashboardController');
const passController = require('../controllers/passController');
const scanController = require('../controllers/scanController');
const printController = require('../controllers/printController');
const categoryController = require('../controllers/categoryController');
const userController = require('../controllers/userController');
const messageController = require('../controllers/messageController');
const auditController = require('../controllers/auditController');

// 1. Health Check
router.get('/health', (req, res) => {
  res.json({
    status: 'online',
    app: 'EventGen Backend API',
    port: process.env.PORT || 5006,
    multiEventEnabled: true,
    time: new Date().toISOString()
  });
});

// 2. Authentication Routes
router.post('/auth/login', authLimiter, authController.login);
router.post('/auth/refresh', authController.refreshToken);
router.get('/auth/me', authenticateToken, authController.getMe);
router.post('/auth/logout', authenticateToken, authController.logout);
router.post('/auth/forgot-password', authLimiter, authController.forgotPassword);
router.post('/auth/reset-password', authLimiter, authController.resetPassword);

// 3. Events Management Routes
router.get('/events', authenticateToken, eventController.getEvents);
router.get('/events/:id', authenticateToken, eventController.getEventById);
router.post('/events', authenticateToken, requireRole('SUPERADMIN'), eventController.createEvent);
router.put('/events/:id', authenticateToken, requireRole('SUPERADMIN'), eventController.updateEvent);
router.put('/events/:id/status', authenticateToken, requireRole('SUPERADMIN'), eventController.toggleEventStatus);

// 4. Dashboard Analytics
router.get('/dashboard/stats', authenticateToken, scopeEventAccess, dashboardController.getDashboardStats);

// 5. Pass Management Routes
router.get('/passes', authenticateToken, scopeEventAccess, passController.getPasses);
router.get('/passes/:id', authenticateToken, scopeEventAccess, passController.getPassById);
router.post('/passes/generate', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), scopeEventAccess, passController.generatePasses);
router.post('/passes/:id/renew', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), passController.renewPass);
router.post('/passes/bulk-renew', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), passController.bulkRenewPasses);
router.post('/passes/:id/void', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), passController.voidPass);
router.post('/passes/:id/reissue', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), passController.reissuePass);

// 6. Scan Routes
router.post('/scan', scanLimiter, optionalAuth, scanController.scan);
router.get('/scan/history', authenticateToken, scopeEventAccess, scanController.getScanHistory);

// 7. Category Routes
router.get('/categories', authenticateToken, scopeEventAccess, categoryController.getCategories);
router.post('/categories', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), scopeEventAccess, categoryController.createCategory);
router.put('/categories/:id', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), categoryController.updateCategory);
router.delete('/categories/:id', authenticateToken, requireRole('SUPERADMIN'), categoryController.deleteCategory);

// 8. Print Batch Management & TSC TE244 Hardware Routes
router.get('/print/batches', authenticateToken, scopeEventAccess, printController.getBatches);
router.post('/print/batches', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), scopeEventAccess, printController.createBatch);
router.get('/print/batches/:id', authenticateToken, printController.getBatchById);
router.post('/print/batches/:id/process', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.processChunk);
router.post('/print/batches/:id/pause', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.pauseBatch);
router.post('/print/batches/:id/resume', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.resumeBatch);
router.post('/print/batches/:id/reprint', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.reprintBatch);
router.post('/print/batches/:id/cancel', authenticateToken, requireRole('SUPERADMIN'), printController.cancelBatch);
router.get('/print/batches/:id/tspl', authenticateToken, printController.downloadTspl);
router.post('/print/test', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.printTest);
router.post('/print/test-barcode', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.printTestBarcode);
router.get('/print/printers', authenticateToken, printController.getPrinters);
router.get('/print/diagnostics', authenticateToken, printController.getDiagnostics);
router.post('/print/calibrate', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.calibrate);
router.post('/print/unpause', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.unpause);
router.post('/print/reconnect', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.reconnect);
router.get('/print/settings', authenticateToken, printController.getSettings);
router.put('/print/settings', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), printController.updateSettings);

// Print Gateway External Endpoints (Secured via X-Gateway-Key header)
router.post('/print/gateway/heartbeat', printController.gatewayHeartbeat);
router.get('/print/gateway/pending', printController.gatewayPending);
router.post('/print/gateway/jobs/:id/status', printController.gatewayJobStatus);

// 9. User & RBAC Management (SuperAdmin only)
router.get('/users', authenticateToken, scopeEventAccess, requireRole('SUPERADMIN'), userController.getUsers);
router.post('/users', authenticateToken, scopeEventAccess, requireRole('SUPERADMIN'), userController.createUser);
router.put('/users/:id', authenticateToken, scopeEventAccess, requireRole('SUPERADMIN'), userController.updateUser);
router.get('/users/roles-permissions', authenticateToken, requireRole('SUPERADMIN'), userController.getRolesAndPermissions);
router.put('/users/roles/:roleId/permissions', authenticateToken, requireRole('SUPERADMIN'), userController.updateRolePermissions);

// 10. Messages Configuration
router.get('/messages', authenticateToken, scopeEventAccess, messageController.getMessages);
router.put('/messages/:key', authenticateToken, requireRole('SUPERADMIN'), messageController.updateMessage);

// 11. Audit Logs
router.get('/audit', authenticateToken, scopeEventAccess, requireRole('SUPERADMIN'), auditController.getAuditLogs);

module.exports = router;
