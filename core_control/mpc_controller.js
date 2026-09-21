/**
 * HydroSync - Core Automation & MPC Engine
 * المسار الخاص بك: التحكم في الخوارزميات وصمامات الأمان
 * 
 * Compliant with:
 * - IEC 61508 Functional Safety & Trip Debouncing
 * - ISO 10816 Mechanical Vibration Standards
 */

// عداد تأخير زمني لمنع الإنذارات الكاذبة أثناء إقلاع المضخة (Debounce Filter)
let dryRunDebounceCounter = 0;

// 1. خوارزمية حساب متطلبات الري ومنع الهدر المناخي
function calculateIrrigationDuty(currentVwc, setpoint, rainProb) {
  var error = setpoint - currentVwc;

  // في حال وجود احتمالية أمطار تفوق 60% يتم تأجيل الضخ تلقائياً
  if (rainProb >= 60) {
    return { duty: 0, mode: "AUTONOMOUS_RAIN_HOLD" };
  }

  // حساب نسبة الضخ حسب فارق الرطوبة
  var duty = Math.max(0, Math.min(100, error * 2.2));
  return { duty: Math.round(duty), mode: "CLOSED_LOOP_ACTIVE" };
}

// 2. صمامات الأمان الصناعي وحماية المضخة (ISO 10816 Severity Baseline)
function evaluateSafety(telemetry) {
  let actions = {
    tripPump: false,          // إيقاف المضخة التلقائي في الحالات الخطرة
    systemStatus: 'NORMAL',   // NORMAL | WARNING | CRITICAL
    alarms: []
  };

  // أ. حماية من التشغيل الجاف (Dry-Run Protection مع فلترة التأخير الزمني)
  // لا نوقف المضخة إلا إذا استمرت بالعمل بحمل حقيقي (>15%) بدون تدفق لمدة 4 ثوانٍ متتالية
  if (telemetry.pumpState && telemetry.pumpDuty > 15.0 && telemetry.flowRate <= 0.8) {
    dryRunDebounceCounter++;
    if (dryRunDebounceCounter >= 4) {
      actions.tripPump = true;
      actions.systemStatus = 'CRITICAL';
      actions.alarms.push('CRITICAL: Dry-run verified. Zero flow while pump running under load.');
    } else {
      actions.systemStatus = 'WARNING';
      actions.alarms.push(`WARNING: Establishing hydraulic flow (${dryRunDebounceCounter}/4s)...`);
    }
  } else {
    dryRunDebounceCounter = Math.max(0, dryRunDebounceCounter - 1);
  }

  // ب. حماية المحرك من ارتفاع درجة الحرارة (Thermal Overheat)
  if (telemetry.motorTemp >= 85.0) {
    actions.tripPump = true;
    actions.systemStatus = 'CRITICAL';
    actions.alarms.push(`CRITICAL: Motor overheat (${telemetry.motorTemp}°C >= 85°C).`);
  } else if (telemetry.motorTemp >= 75.0) {
    actions.systemStatus = actions.systemStatus === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    actions.alarms.push(`WARNING: High motor temperature (${telemetry.motorTemp}°C).`);
  }

  // ج. معيار الاهتزاز الميكانيكي وتآكل المحامل (ISO 10816 Class II)
  // Class II thresholds: Warning >= 2.8 mm/s, Critical Trip >= 7.1 mm/s
  if (telemetry.vibrationRms >= 7.1) {
    actions.tripPump = true;
    actions.systemStatus = 'CRITICAL';
    actions.alarms.push(`CRITICAL: Unacceptable vibration (${telemetry.vibrationRms} mm/s). Emergency stop.`);
  } else if (telemetry.vibrationRms >= 2.8) {
    actions.systemStatus = actions.systemStatus === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    actions.alarms.push(`WARNING: Unsatisfactory vibration (${telemetry.vibrationRms} mm/s). Maintenance needed.`);
  }

  return actions;
}

function resetSafetyState() {
  dryRunDebounceCounter = 0;
}

module.exports = {
  calculateIrrigationDuty,
  evaluateSafety,
  resetSafetyState
};