const allocationService = require('../services/AllocationService');

async function getAllocations(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const { cashierId, categoryId, search, page = 1, limit = 20 } = req.query;

    const result = await allocationService.getAllocations({
      eventId,
      cashierId,
      categoryId,
      search,
      page,
      limit
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function createAllocation(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.body.eventId || req.body.event_id;
    const categoryId = req.body.categoryId || req.body.category_id;
    const cashierId = req.body.cashierId || req.body.cashier_id;
    const quantity = req.body.quantity !== undefined ? req.body.quantity : (req.body.allocated_quantity !== undefined ? req.body.allocated_quantity : req.body.allocatedQuantity);
    const notes = req.body.notes || req.body.allocation_notes;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await allocationService.createAllocation({
      eventId,
      categoryId,
      cashierId,
      quantity,
      notes,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Pass quota allocated successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function updateAllocationQuantity(req, res, next) {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await allocationService.updateAllocationQuantity({
      allocationId: id,
      newQuantity: quantity,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Allocation quantity updated successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function getMyAllocations(req, res, next) {
  try {
    const cashierId = req.user?.id;
    const eventId = req.user?.eventId || req.query.eventId || null;

    if (!cashierId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const allocations = await allocationService.getMyAllocations(cashierId, eventId);

    res.json({
      success: true,
      data: allocations,
      allocations
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAllocations,
  createAllocation,
  updateAllocationQuantity,
  getMyAllocations
};
