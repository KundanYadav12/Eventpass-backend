const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

let transporter = null;

function getEmailTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASS || ''
      }
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || '"EventGen Support" <noreply@eventgen.duckdns.org>';
  
  // If SMTP is not configured or in test mode, log email instead of failing
  if (!process.env.EMAIL_PASS || process.env.EMAIL_PASS.startsWith('mock_')) {
    console.log(`[Email Preview] (SMTP Simulated) To: ${to} | Subject: ${subject}`);
    console.log(`[Email Content]:\n${text || html}\n`);
    return { success: true, messageId: 'simulated-' + Date.now() };
  }

  try {
    const t = getEmailTransporter();
    const info = await t.sendMail({
      from,
      to,
      subject,
      text,
      html
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('[Email Error] Failed to send email:', error.message);
    throw error;
  }
}

module.exports = {
  getEmailTransporter,
  sendEmail
};
