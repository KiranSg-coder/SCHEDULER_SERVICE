// src/controllers/webhook.controller.js
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

const receiveModeChange = async (req, res) => {
  try {
    const { userId, newMode, previousMode, reason, effectiveDate, modeChangeId, minimumRuleIds } = req.body;

    const normalizedEffectiveDate = effectiveDate
      ? String(effectiveDate).split("T")[0]
      : null;

    console.log(`[Webhook] Mode change received for user ${userId}:`, {
      previousMode,
      newMode,
      reason,
      effectiveDate,
      normalizedEffectiveDate,
      modeChangeId,
      minimumRuleIds,
    });

    // Store pending mode change
    await sequelize.query(
      `EXEC USP_STORE_MODE_CHANGE 
        @USERID = :userId,
        @NEWMODE = :newMode,
        @PREVIOUSMODE = :previousMode,
        @REASON = :reason,
        @EFFECTIVEDATE = :effectiveDate,
        @MODECHANGEID = :modeChangeId,
        @MINIMUMRULEIDS = :minimumRuleIds`,
      {
        replacements: {
          userId,
          newMode,
          previousMode: previousMode || 'STANDARD',
          reason,
          effectiveDate: normalizedEffectiveDate || effectiveDate,
          modeChangeId,
          minimumRuleIds: minimumRuleIds ? JSON.stringify(minimumRuleIds) : null,
        },
        type: QueryTypes.SELECT,
      }
    );

    console.log(`[Webhook] ✓ Mode change queued for ${normalizedEffectiveDate || effectiveDate}`);

    return res.status(200).json({
      success: true,
      message: 'Mode change queued successfully',
    });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to process mode change',
      },
    });
  }
};

module.exports = { receiveModeChange };