const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../config/db');
const { logAudit } = require('../services/AuditService');

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/profiles');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * GET /api/public/profile
 * Public endpoint to fetch active public event profile and branding
 */
async function getPublicProfile(req, res, next) {
  try {
    const { id, eventCode } = req.query;
    let eventRow = null;

    if (id) {
      const rows = await query('SELECT * FROM events WHERE id = ? LIMIT 1', [id]);
      if (rows.length > 0) eventRow = rows[0];
    } else if (eventCode) {
      const rows = await query('SELECT * FROM events WHERE event_code = ? LIMIT 1', [eventCode.trim().toUpperCase()]);
      if (rows.length > 0) eventRow = rows[0];
    }

    // Default to first active / featured event (e.g. Rass Utsav 2026)
    if (!eventRow) {
      const featured = await query('SELECT * FROM events WHERE is_featured_public = 1 AND status = "active" ORDER BY id ASC LIMIT 1');
      if (featured.length > 0) {
        eventRow = featured[0];
      } else {
        const anyActive = await query('SELECT * FROM events WHERE status = "active" ORDER BY id ASC LIMIT 1');
        if (anyActive.length > 0) {
          eventRow = anyActive[0];
        } else {
          const fallback = await query('SELECT * FROM events ORDER BY id ASC LIMIT 1');
          eventRow = fallback[0] || null;
        }
      }
    }

    if (!eventRow) {
      return res.status(404).json({ success: false, message: 'No event profile configured yet' });
    }

    // Fetch system settings for branding
    const settingRows = await query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    settingRows.forEach(s => { settings[s.setting_key] = s.setting_value; });

    // Fetch public categories for this event
    const categories = await query(
      'SELECT id, name, code, price, total_quantity, description FROM pass_categories WHERE event_id = ? ORDER BY id ASC',
      [eventRow.id]
    );

    // Parse social links if stored as JSON
    let socialLinks = {};
    if (eventRow.social_links) {
      try {
        socialLinks = typeof eventRow.social_links === 'string' ? JSON.parse(eventRow.social_links) : eventRow.social_links;
      } catch (e) {
        socialLinks = {};
      }
    }

    const profile = {
      id: eventRow.id,
      event_name: eventRow.event_name || 'Rass Utsav 2026',
      event_code: eventRow.event_code,
      category: eventRow.category || 'Garba & Cultural Rass Utsav',
      description: eventRow.description || 'Experience the divine celebration of rhythm, devotion, and traditional heritage at Rass Utsav 2026. Controlled entry and high-speed barcode verification powered by Manage My Show.',
      venue: eventRow.venue || 'Grand Heritage Grounds, Borivali / Kandivali, Mumbai',
      event_start_date: eventRow.event_start_date,
      event_end_date: eventRow.event_end_date,
      status: eventRow.status,
      banner_image: eventRow.banner_image || null,
      organizer_name: eventRow.organizer_name || 'Ariso Traders',
      organizer_desc: eventRow.organizer_desc || 'Premier cultural and event production organization bringing authentic celebrations to life with state-of-the-art entry technology.',
      contact_email: eventRow.contact_email || 'jignesh2515@gmail.com',
      contact_phone: eventRow.contact_phone || '+91 98200 00000',
      enquiry_email: eventRow.enquiry_email || 'jignesh2515@gmail.com',
      instagram_url: eventRow.instagram_url || 'https://www.instagram.com/arisotraders?igsi=MTRjcHVsbXJxOTR0cQ==',
      social_links: socialLinks,
      cta_text: eventRow.cta_text || 'Get Your Pass',
      cta_url: eventRow.cta_url || '/login',
      footer_heading: eventRow.footer_heading || 'Manage My Show',
      footer_text: eventRow.footer_text || 'Powering smarter event access and pass validation.',
      platform_name: settings.platform_name || 'Manage My Show',
      categories
    };

    res.json({
      success: true,
      profile
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/profile/:id
 * SuperAdmin only: Update event profile & public settings
 */
async function updateProfile(req, res, next) {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Valid event ID is required' });
    }

    const {
      event_name,
      category,
      description,
      venue,
      event_start_date,
      event_end_date,
      banner_image,
      organizer_name,
      organizer_desc,
      contact_email,
      contact_phone,
      enquiry_email,
      instagram_url,
      social_links,
      cta_text,
      cta_url,
      footer_heading,
      footer_text,
      platform_name
    } = req.body;

    const existing = await query('SELECT id FROM events WHERE id = ?', [eventId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // Serialize social links
    let socialLinksJson = null;
    if (social_links) {
      socialLinksJson = typeof social_links === 'string' ? social_links : JSON.stringify(social_links);
    }

    await query(
      `UPDATE events SET
        event_name = COALESCE(?, event_name),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        venue = COALESCE(?, venue),
        event_start_date = COALESCE(?, event_start_date),
        event_end_date = COALESCE(?, event_end_date),
        banner_image = COALESCE(?, banner_image),
        organizer_name = COALESCE(?, organizer_name),
        organizer_desc = COALESCE(?, organizer_desc),
        contact_email = COALESCE(?, contact_email),
        contact_phone = COALESCE(?, contact_phone),
        enquiry_email = COALESCE(?, enquiry_email),
        instagram_url = COALESCE(?, instagram_url),
        social_links = COALESCE(?, social_links),
        cta_text = COALESCE(?, cta_text),
        cta_url = COALESCE(?, cta_url),
        footer_heading = COALESCE(?, footer_heading),
        footer_text = COALESCE(?, footer_text),
        updated_at = NOW()
       WHERE id = ?`,
      [
        event_name || null,
        category || null,
        description !== undefined ? description : null,
        venue || null,
        event_start_date || null,
        event_end_date || null,
        banner_image !== undefined ? banner_image : null,
        organizer_name || null,
        organizer_desc !== undefined ? organizer_desc : null,
        contact_email !== undefined ? contact_email : null,
        contact_phone !== undefined ? contact_phone : null,
        enquiry_email || null,
        instagram_url || null,
        socialLinksJson,
        cta_text || null,
        cta_url || null,
        footer_heading || null,
        footer_text !== undefined ? footer_text : null,
        eventId
      ]
    );

    // Update platform name in system_settings if sent
    if (platform_name && String(platform_name).trim()) {
      const cleanBrand = String(platform_name).trim();
      await query(
        `INSERT INTO system_settings (setting_key, setting_value, description, updated_at)
         VALUES ('platform_name', ?, 'Platform Brand Name', NOW())
         ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
        [cleanBrand, cleanBrand]
      );
    }

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_EVENT_PROFILE',
      entity: 'EVENT_PROFILE',
      entityId: eventId,
      newValue: { event_name, category, organizer_name, enquiry_email, instagram_url },
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    const [updated] = await query('SELECT * FROM events WHERE id = ?', [eventId]);

    res.json({
      success: true,
      message: 'Event profile updated successfully',
      profile: updated
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/profile/:id/upload-image
 * SuperAdmin only: Upload and compress profile hero/banner image
 */
async function uploadProfileImage(req, res, next) {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { imageBase64, mimeType, fileName } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Image base64 data required' });
    }

    // Extract raw base64 data
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let resolvedMime = mimeType || 'image/jpeg';
    let rawBase64 = imageBase64;

    if (matches && matches.length === 3) {
      resolvedMime = matches[1];
      rawBase64 = matches[2];
    }

    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(resolvedMime.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid image format. Supported formats: JPG, JPEG, PNG, WebP'
      });
    }

    const buffer = Buffer.from(rawBase64, 'base64');

    // Max 8MB check
    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'Image size exceeds maximum limit of 8MB'
      });
    }

    let ext = 'jpg';
    if (resolvedMime.includes('png')) ext = 'png';
    else if (resolvedMime.includes('webp')) ext = 'webp';

    const safeHash = crypto.randomBytes(8).toString('hex');
    const safeFileName = `event_${eventId || 'profile'}_${Date.now()}_${safeHash}.${ext}`;
    const destinationPath = path.join(UPLOADS_DIR, safeFileName);

    fs.writeFileSync(destinationPath, buffer);

    const publicUrl = `/uploads/profiles/${safeFileName}`;

    // Automatically update the event banner_image in DB if eventId is provided
    if (eventId) {
      await query('UPDATE events SET banner_image = ? WHERE id = ?', [publicUrl, eventId]);
    }

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPLOAD_PROFILE_IMAGE',
      entity: 'EVENT_PROFILE',
      entityId: eventId,
      newValue: { imageUrl: publicUrl, sizeBytes: buffer.length },
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Profile image uploaded successfully',
      imageUrl: publicUrl
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPublicProfile,
  updateProfile,
  uploadProfileImage
};
