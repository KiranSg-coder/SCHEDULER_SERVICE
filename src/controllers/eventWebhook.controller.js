const handleEvent = async (req, res) => {
    try {
      const { eventType, payload, userId, eventId } = req.body;
  
      console.log(`[Scheduler Event] 📨 ${eventType} for user ${userId} (eventId=${eventId})`);
  
      switch (eventType) {
        case "MODE_CHANGED_TO_MINIMUM":
          console.log(`[Scheduler Event] ⚠️ User ${userId} entering MINIMUM mode on ${payload.effectiveDate}`);
          break;
        case "MODE_CHANGED_TO_STANDARD":
          console.log(`[Scheduler Event] ✅ User ${userId} back to STANDARD mode on ${payload.effectiveDate}`);
          break;
        default:
          console.log(`[Scheduler Event] ℹ️ Unhandled event type: ${eventType}`);
      }
  
      return res.status(200).json({ success: true, received: true, eventId });
    } catch (err) {
      console.error("[Scheduler Event] ❌ Error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  };
  
  module.exports = { handleEvent };