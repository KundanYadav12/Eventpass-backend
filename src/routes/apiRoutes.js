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
const passStyleController = require('../controllers/passStyleController');
const billingController = require('../controllers/billingController');
const deliveryController = require('../controllers/deliveryController');
const salesController = require('../controllers/salesController');
const allocationController = require('../controllers/allocationController');
const checkpointController = require('../controllers/checkpointController');
const gateController = require('../controllers/gateController');
const cashierController = require('../controllers/cashierController');
const userController = require('../controllers/userController');
const messageController = require('../controllers/messageController');
const auditController = require('../controllers/auditController');
const systemController = require('../controllers/systemController');
const profileController = require('../controllers/profileController');
const databaseController = require('../controllers/databaseController');
const selfRegistrationController = require('../controllers/selfRegistrationController');

// 1. Health Check & Platform Settings
router.get('/health', (req, res) => {
  res.json({
    status: 'online',
    app: 'EventGen Backend API',
    port: process.env.PORT || 5006,
    multiEventEnabled: true,
    timezone: 'Asia/Kolkata (IST, UTC+5:30)',
    time: new Date().toISOString()
  });
});

router.get('/system/settings', systemController.getSystemSettings);
router.put('/system/settings', authenticateToken, requireRole('SUPERADMIN'), systemController.updateSystemSettings);

// Manage My Show Public Profile & SuperAdmin Profile Management
router.get('/public/profile', profileController.getPublicProfile);
router.put('/profile/:id', authenticateToken, requireRole('SUPERADMIN'), profileController.updateProfile);
router.post('/profile/:id/upload-image', authenticateToken, requireRole('SUPERADMIN'), profileController.uploadProfileImage);

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

// 5. Pass Management Routes (Require 'passes.generate' or view permissions)
router.get('/passes', authenticateToken, scopeEventAccess, passController.getPasses);
router.get('/passes/export-excel', authenticateToken, scopeEventAccess, passController.exportPassesExcel);
router.get('/passes/:id', authenticateToken, scopeEventAccess, passController.getPassById);
router.post('/passes/:id/reshare', authenticateToken, scopeEventAccess, passController.resharePass);
router.post('/passes/generate', authenticateToken, requirePermission('passes.generate'), scopeEventAccess, passController.generatePasses);
router.post('/passes/:id/renew', authenticateToken, requireRole('SUPERADMIN'), passController.renewPass);
router.post('/passes/bulk-renew', authenticateToken, requireRole('SUPERADMIN'), passController.bulkRenewPasses);
router.post('/passes/:id/void', authenticateToken, requireRole('SUPERADMIN'), passController.voidPass);
router.post('/passes/:id/reissue', authenticateToken, requireRole('SUPERADMIN'), passController.reissuePass);

// 6. Scan Routes
router.post('/scan', scanLimiter, optionalAuth, scanController.scan);
router.get('/scan/history', authenticateToken, scopeEventAccess, scanController.getScanHistory);
router.get('/scan/fraud-stats', optionalAuth, scanController.getFraudStats);

// 7. Category Routes (Require 'categories.create' permission for creation)
router.get('/categories', authenticateToken, scopeEventAccess, categoryController.getCategories);
router.post('/categories', authenticateToken, requirePermission(['categories.create', 'categories.manage', 'allocations.manage']), scopeEventAccess, categoryController.createCategory);
router.put('/categories/:id', authenticateToken, requirePermission(['categories.create', 'categories.manage', 'allocations.manage']), scopeEventAccess, categoryController.updateCategory);
router.delete('/categories/:id', authenticateToken, requireRole('SUPERADMIN'), categoryController.deleteCategory);

// 8. Pass Style / Designer Routes
router.get('/pass-styles', authenticateToken, scopeEventAccess, requirePermission(['pass_styles.view', 'pass_styles.use', 'billing.create', 'passes.generate']), passStyleController.getStyles);
router.get('/pass-styles/:id', authenticateToken, scopeEventAccess, requirePermission(['pass_styles.view', 'pass_styles.use', 'billing.create', 'passes.generate']), passStyleController.getStyleById);
router.post('/pass-styles', authenticateToken, scopeEventAccess, requirePermission('pass_styles.create'), passStyleController.createStyle);
router.put('/pass-styles/:id', authenticateToken, scopeEventAccess, requirePermission('pass_styles.edit'), passStyleController.updateStyle);
router.delete('/pass-styles/:id', authenticateToken, scopeEventAccess, requirePermission('pass_styles.delete'), passStyleController.deleteStyle);

// 9. Customer Billing & Pass Issuance Routes
router.post('/billing/preview', authenticateToken, scopeEventAccess, requirePermission('billing.create'), billingController.previewBilling);
router.post('/billing/issue-and-send', authenticateToken, scopeEventAccess, requirePermission('billing.create'), billingController.issuePassesAndBill);
router.post('/billing/:id/resend-delivery', authenticateToken, scopeEventAccess, requirePermission(['billing.create', 'cashier.sell', 'cashier.view_own_sales']), billingController.resendBillingDelivery);
router.get('/billing/history', authenticateToken, scopeEventAccess, billingController.getBillingHistory);

// Public Customer PDF Downloads (Secured by unguessable cryptographic token — no login needed)
router.get('/public/download/pass/:token', billingController.downloadPassPdfByToken);
router.get('/public/download/bill/:token', billingController.downloadBillPdfByToken);
router.get('/billing/download/pass/:token', billingController.downloadPassPdfByToken);
router.get('/billing/download/bill/:token', billingController.downloadBillPdfByToken);
router.get('/billing/:id/download-pass', billingController.downloadPassPdfByToken);
router.get('/billing/:id/download-bill', billingController.downloadBillPdfByToken);

// 10. Self Registration Routes (Public Attendee Registration & Admin Management)
// Public Customer Self Registration (No login needed — secured by unguessable cryptographic token & rate limited)
router.get('/public/self-registration/:token', selfRegistrationController.getPublicConfig);
router.post('/public/self-registration/:token/register', authLimiter, selfRegistrationController.submitRegistration);

// Admin Self Registration Management
router.get('/self-registrations', authenticateToken, scopeEventAccess, selfRegistrationController.getAll);
router.post('/self-registrations', authenticateToken, scopeEventAccess, requirePermission(['self_registration.manage', 'passes.generate', 'billing.create', 'events.manage']), selfRegistrationController.create);
router.get('/self-registrations/:id', authenticateToken, scopeEventAccess, selfRegistrationController.getById);
router.put('/self-registrations/:id', authenticateToken, scopeEventAccess, requirePermission(['self_registration.manage', 'passes.generate', 'billing.create', 'events.manage']), selfRegistrationController.update);
router.put('/self-registrations/:id/status', authenticateToken, scopeEventAccess, requirePermission(['self_registration.manage', 'passes.generate', 'billing.create', 'events.manage']), selfRegistrationController.toggleStatus);
router.get('/self-registrations/:id/attendees', authenticateToken, scopeEventAccess, selfRegistrationController.getAttendees);

// 11. Sales Report Module Routes (Protected with RBAC 'sales.view' permission & event scoping)
router.get('/sales/summary', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getSalesSummary);
router.get('/sales/transactions', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getSalesTransactions);
router.get('/sales/categories', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getCategorySales);
router.get('/sales/events', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getEventSales);
router.get('/sales/trend', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getSalesTrend);
router.get('/sales/payment-summary', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getPaymentSummary);
router.get('/sales/customers', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getCustomerSales);
router.get('/sales/cashier-summary', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getCashierSalesSummary);
router.get('/sales/export-excel', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.exportSalesExcel);

// 11. Dynamic Scan Checkpoints Routes
router.get('/events/:eventId/checkpoints', authenticateToken, scopeEventAccess, checkpointController.getCheckpoints);
router.get('/checkpoints', authenticateToken, scopeEventAccess, checkpointController.getCheckpoints);
router.post('/checkpoints', authenticateToken, scopeEventAccess, requirePermission(['checkpoints.manage', 'events.manage']), checkpointController.createCheckpoint);
router.put('/checkpoints/:id', authenticateToken, scopeEventAccess, requirePermission(['checkpoints.manage', 'events.manage']), checkpointController.updateCheckpoint);
router.delete('/checkpoints/:id', authenticateToken, scopeEventAccess, requirePermission(['checkpoints.manage', 'events.manage']), checkpointController.deleteCheckpoint);

// 12. Cashier Pass Allocations Routes
router.get('/allocations', authenticateToken, scopeEventAccess, requirePermission(['allocations.manage', 'users.manage']), allocationController.getAllocations);
router.post('/allocations', authenticateToken, scopeEventAccess, requirePermission(['allocations.manage', 'users.manage']), allocationController.createAllocation);
router.put('/allocations/:id', authenticateToken, scopeEventAccess, requirePermission(['allocations.manage', 'users.manage']), allocationController.updateAllocationQuantity);

// 13. Cashier Dedicated Selling & Personal Reports
router.get('/cashier/my-allocations', authenticateToken, allocationController.getMyAllocations);
router.post('/cashier/sell', authenticateToken, requirePermission(['cashier.sell', 'billing.create']), cashierController.sellPass);
router.get('/cashier/my-sales', authenticateToken, requirePermission(['cashier.view_own_sales', 'cashier.sell']), cashierController.getMySales);
router.get('/cashier/my-export', authenticateToken, requirePermission(['cashier.view_own_sales', 'cashier.sell']), cashierController.exportMySalesExcel);

// 14. Print Batch Management & TSC TE244 Hardware Routes (SuperAdmin Only)
router.get('/print/batches', authenticateToken, scopeEventAccess, printController.getBatches);
router.post('/print/batches', authenticateToken, requireRole('SUPERADMIN'), scopeEventAccess, printController.createBatch);
router.get('/print/batches/:id', authenticateToken, printController.getBatchById);
router.post('/print/batches/:id/process', authenticateToken, requireRole('SUPERADMIN'), printController.processChunk);
router.post('/print/batches/:id/process-chunk', authenticateToken, requireRole('SUPERADMIN'), printController.processChunk);
router.post('/print/batches/:id/pause', authenticateToken, requireRole('SUPERADMIN'), printController.pauseBatch);
router.post('/print/batches/:id/resume', authenticateToken, requireRole('SUPERADMIN'), printController.resumeBatch);
router.post('/print/batches/:id/reprint', authenticateToken, requireRole('SUPERADMIN'), printController.reprintBatch);
router.post('/print/batches/:id/cancel', authenticateToken, requireRole('SUPERADMIN'), printController.cancelBatch);
router.get('/print/batches/:id/tspl', authenticateToken, printController.downloadTspl);
router.post('/print/test', authenticateToken, requireRole('SUPERADMIN'), printController.printTest);
router.post('/print/test-barcode', authenticateToken, requireRole('SUPERADMIN'), printController.printTestBarcode);
router.get('/print/printers', authenticateToken, printController.getPrinters);
router.get('/print/diagnostics', authenticateToken, printController.getDiagnostics);
router.post('/print/calibrate', authenticateToken, requireRole('SUPERADMIN'), printController.calibrate);
router.post('/print/unpause', authenticateToken, requireRole('SUPERADMIN'), printController.unpause);
router.post('/print/reconnect', authenticateToken, requireRole('SUPERADMIN'), printController.reconnect);
router.get('/print/settings', authenticateToken, printController.getSettings);
router.put('/print/settings', authenticateToken, requireRole('SUPERADMIN'), printController.updateSettings);

// Print Gateway External Endpoints (Secured via X-Gateway-Key header)
router.post('/print/gateway/heartbeat', printController.gatewayHeartbeat);
router.get('/print/gateway/pending', printController.gatewayPending);
router.post('/print/gateway/jobs/:id/status', printController.gatewayJobStatus);

// 15. User & RBAC Management
router.get('/users', authenticateToken, scopeEventAccess, requirePermission(['users.manage', 'allocations.manage']), userController.getUsers);
router.get('/users/roles-permissions', authenticateToken, requirePermission(['users.manage', 'allocations.manage']), userController.getRolesAndPermissions);
router.put('/users/roles/:roleId/permissions', authenticateToken, requireRole('SUPERADMIN'), userController.updateRolePermissions);
router.get('/users/event-permissions', authenticateToken, requireRole('SUPERADMIN'), userController.getEventPermissions);
router.put('/users/event-permissions', authenticateToken, requireRole('SUPERADMIN'), userController.updateEventPermissions);
router.post('/users', authenticateToken, scopeEventAccess, requirePermission(['users.manage', 'allocations.manage']), userController.createUser);
router.put('/users/:id', authenticateToken, scopeEventAccess, requirePermission(['users.manage', 'allocations.manage']), userController.updateUser);

// Scoped Cashier Accounts Management (Gated by cashiers.manage permission or SuperAdmin)
router.get('/cashiers', authenticateToken, scopeEventAccess, requirePermission('cashiers.manage'), userController.getCashierAccounts);
router.post('/cashiers', authenticateToken, scopeEventAccess, requirePermission('cashiers.manage'), userController.createCashierAccount);
router.put('/cashiers/:id', authenticateToken, scopeEventAccess, requirePermission('cashiers.manage'), userController.updateCashierAccount);
router.get('/cashiers/:id/sales', authenticateToken, scopeEventAccess, requirePermission('cashiers.manage'), userController.getCashierSalesReport);

// 16. Messages Configuration
router.get('/messages', authenticateToken, scopeEventAccess, messageController.getMessages);
router.put('/messages/:key', authenticateToken, requireRole('SUPERADMIN'), messageController.updateMessage);

// 17. Audit Logs
router.get('/audit', authenticateToken, scopeEventAccess, requireRole('SUPERADMIN'), auditController.getAuditLogs);

// 18. Event-Scoped Email & WhatsApp Delivery Routes
router.get('/events/:eventId/delivery/email', authenticateToken, scopeEventAccess, deliveryController.getEmailSettings);
router.put('/events/:eventId/delivery/email', authenticateToken, scopeEventAccess, deliveryController.updateEmailSettings);
router.post('/events/:eventId/delivery/email/test', authenticateToken, scopeEventAccess, deliveryController.testEmail);
router.get('/events/:eventId/delivery/whatsapp', authenticateToken, scopeEventAccess, deliveryController.getWhatsappSettings);
router.put('/events/:eventId/delivery/whatsapp', authenticateToken, scopeEventAccess, deliveryController.updateWhatsappSettings);
router.get('/events/:eventId/delivery/logs', authenticateToken, scopeEventAccess, deliveryController.getDeliveryLogs);

// 19. Cashier Quota Allocations
router.get('/allocations', authenticateToken, scopeEventAccess, requirePermission('allocations.manage'), allocationController.getAllocations);
router.post('/allocations', authenticateToken, scopeEventAccess, requirePermission('allocations.manage'), allocationController.createAllocation);
router.put('/allocations/:id', authenticateToken, scopeEventAccess, requirePermission('allocations.manage'), allocationController.updateAllocationQuantity);
router.get('/cashier/my-allocations', authenticateToken, allocationController.getMyAllocations);

// 20. Dynamic Scan Checkpoints
router.get('/events/:eventId/checkpoints', authenticateToken, scopeEventAccess, checkpointController.getCheckpoints);
router.post('/events/:eventId/checkpoints', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), checkpointController.createCheckpoint);
router.put('/checkpoints/:id', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), checkpointController.updateCheckpoint);
router.delete('/checkpoints/:id', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), checkpointController.deleteCheckpoint);

// Dynamic Event Gates / Devices
router.get('/events/:eventId/gates', authenticateToken, scopeEventAccess, gateController.getGates);
router.post('/events/:eventId/gates', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), gateController.createGate);
router.put('/gates/:id', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), gateController.updateGate);
router.delete('/gates/:id', authenticateToken, scopeEventAccess, requirePermission('checkpoints.manage'), gateController.deleteGate);

// 21. Cashier POS Sales & Self Reports
router.post('/cashier/sell', authenticateToken, scopeEventAccess, requirePermission('cashier.sell'), cashierController.sellPass);
router.get('/cashier/my-sales', authenticateToken, cashierController.getMySales);
router.get('/cashier/my-sales/export-excel', authenticateToken, cashierController.exportMySalesExcel);

// 22. Cashier Summary in Sales
router.get('/sales/cashier-summary', authenticateToken, scopeEventAccess, requirePermission('sales.view'), salesController.getCashierSalesSummary);

// 23. SuperAdmin Database Explorer & Controlled Editor (SuperAdmin Only)
router.get('/database/tables', authenticateToken, requireRole('SUPERADMIN'), databaseController.getTables);
router.get('/database/tables/:table/schema', authenticateToken, requireRole('SUPERADMIN'), databaseController.getTableSchema);
router.get('/database/tables/:table/records', authenticateToken, requireRole('SUPERADMIN'), databaseController.getTableRecords);
router.get('/database/tables/:table/columns/:column/distinct', authenticateToken, requireRole('SUPERADMIN'), databaseController.getColumnDistinctValues);
router.get('/database/tables/:table/records/:id', authenticateToken, requireRole('SUPERADMIN'), databaseController.getRecordById);
router.put('/database/tables/:table/records/:id', authenticateToken, requireRole('SUPERADMIN'), databaseController.updateRecord);
router.delete('/database/tables/:table/records/:id', authenticateToken, requireRole('SUPERADMIN'), databaseController.deleteRecord);

module.exports = router;
