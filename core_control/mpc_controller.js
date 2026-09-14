/**
 * HydroSync - Core Automation & MPC Engine
 * المسار الخاص بك: التحكم في الخوارزميات وصمامات الأمان
 */

// خوارزمية حساب متطلبات الري ومنع الهدر المناخي
function calculateIrrigationDuty(currentVwc, setpoint, rainProb) {
  var error = setpoint - currentVwc;

  // في حال وجود احتمالية أمطار تفوق 60% يتم تأجيل الضخ تلقائياً
  if (rainProb >= 60) {
    return { duty: 0, mode: "AUTONOMOUS_RAIN_HOLD" };
  }

  // حساب نسبة الضخ حسب فارق الرطوبة
  var duty = Math.max(0, Math.min(100, error * 2.2));
  return { duty: duty, mode: "CLOSED_LOOP_ACTIVE" };
}

module.exports = { calculateIrrigationDuty };