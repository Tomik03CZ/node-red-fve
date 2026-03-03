// ═══════════════════════════════════════════════════════════════════════════
// SYSTÉM ŘÍZENÍ PŘEBYTKŮ Z FVE - PROVOZNÍ DOKUMENTACE
// ═══════════════════════════════════════════════════════════════════════════
//
// VSTUPY: Grid power sensor, EV senzory, termostat, manual overrides
// VÝSTUPY: [statusMessages, permissionMessages, scanIntervalMessages]
//
// KLÍČOVÉ BEZPEČNOSTNÍ POJISTKY:
// - Ochrana baterie: deficit nabíjení = postupné vypínání od nejnižší priority
// - Referenční tracking: sleduje historický výkon nabíjení baterie
// - Stabilizace nabíjení: 60s (SOC<80%), 30s (SOC≥80%), 0s (SOC=100% nebo nenabíjí)
// - EV data starší než 30 min = zakázáno nabíjení
// - Asymetrický cooldown: vypnutí okamžité, zapnutí 10s
// - Servisní režim = zamrzlá konfigurace
// - Manuální override = uživatel má přednost
//
// DEBUGOVÁNÍ:
// - Při problémech zkontrolovat context.get('lastStates')
// - Cooldowny v context.get('permCooldowns')
// - Frozen config v context.get('frozenConfig')
// ═══════════════════════════════════════════════════════════════════════════

const devices = [
    {
        name: "Volkswagen - ID.4",
        entity: "light.smart_dimled_zigbee_zd1_0_1_10v_ovladani_wallbox",
        permission: "input_boolean.povolit_zapnuti_volkswagen_id_4",
        isEV: true,
        // Lookup tabulka: přesné mapování výkon/brightness (nelineární!)
        evPowerTable: [
            { watt: 4157, brightness: 13 },  // 6A
            { watt: 4850, brightness: 16 },  // 7A
            { watt: 5543, brightness: 19 },  // 8A
            { watt: 6235, brightness: 23 },  // 9A
            { watt: 6928, brightness: 26 },  // 10A
            { watt: 7621, brightness: 30 },  // 11A
            { watt: 8314, brightness: 33 },  // 12A
            { watt: 9007, brightness: 36 },  // 13A
            { watt: 9700, brightness: 39 },  // 14A
            { watt: 10392, brightness: 42 },  // 15A
            { watt: 11085, brightness: 46 }   // 16A
        ],
        minBrightness: 13,  // Minimum pro detekci běhu
        minWatt: 4157,      // Pro zpětnou kompatibilitu
        maxWatt: 11085
    },
    {
        name: "Infračervené topné panely (Motorkárna)",
        watt: 1200,
        entity: "switch.nous_smart_switch_d1z_16a_infracervene_topne_panely_motorkarna",
        permission: "input_boolean.povolit_zapnuti_infracervene_topne_panely_motorkarna",
        heatingNeeded: "potreba_zapnout_topeni_termostat_motorkarna_prebytky_z_fve",
        manualOverride: "manualni_zapnuti_topeni_v_motorkarne"
    },
    {
        name: "Žebříkový radiátor (dolní koupelna)",
        watt: 400,
        entity: "switch.tretakt_smart_plug_elektricke_topeni_dolni_koupelna_spinac",
        permission: "input_boolean.povolit_zapnuti_zebrikovy_radiator_dolni_koupelna"
    },
    {
        name: "Žebříkový radiátor (horní koupelna)",
        watt: 400,
        entity: "switch.tretakt_smart_plug_elektricke_topeni_horni_koupelna_spinac",
        permission: "input_boolean.povolit_zapnuti_zebrikovy_radiator_horni_koupelna"
    }
];

const GRID_SENSOR = "sensor.stridac_garaz_grid_power";
const MANUAL_CHARGE_ENTITY = "input_boolean.spustit_nabijeni_auta_id_4";
const SYSTEM_SWITCH_ENTITY = "input_boolean.zapnuti_vypnuti_celeho_systemu_rizeni_prebytku_fve";
const SERVICE_MODE_ENTITY = "input_boolean.servisni_rezim_rizeni_prebytku_fve";

const EV_BATTERY = "sensor.id_4_battery_level";
const EV_CABLE = "binary_sensor.id_4_charging_cable_connected";
const EV_POWER = "sensor.id_4_charging_power";
const EV_ONLINE = "binary_sensor.id_4_connection_online";
const EV_LOCATION = "device_tracker.67967d58e24d4d0012aaed75_device_tracker";

const SCAN_INTERVAL_ENTITY = "number.id_4_scan_interval";
const SCAN_FAST = 1;
const SCAN_SLOW = 5;

// 30 minut - bezpečnostní buffer pro výpadky mobilní sítě EV
// (WeConnect API má občas 10-20min zpoždění)
const EV_DATA_MAX_AGE_MINUTES = 30;

// Vypínače pro jednotlivé priority
const PRIORITY_SWITCHES = [
    "input_boolean.zapnuti_provozu_spotrebice_z_prebytku_priorita_1",
    "input_boolean.zapnuti_provozu_spotrebice_z_prebytku_priorita_2",
    "input_boolean.zapnuti_provozu_spotrebice_z_prebytku_priorita_3",
    "input_boolean.zapnuti_provozu_spotrebice_z_prebytku_priorita_4"
];

const TOPIC_GRID = "stridac_garaz_grid_power";
const TOPIC_MANUAL = "spustit_nabijeni_auta_id_4";
const TOPIC_SYSTEM = "zapnuti_vypnuti_celeho_systemu_rizeni_prebytku_fve";
const TOPIC_SERVICE = "servisni_rezim_rizeni_prebytku_fve";
const TOPIC_BATTERY = "id_4_battery_level";
const TOPIC_CABLE = "id_4_charging_cable_connected";
const TOPIC_POWER = "id_4_charging_power";
const TOPIC_ONLINE = "id_4_connection_online";
const TOPIC_LOCATION = "67967d58e24d4d0012aaed75_device_tracker";
const TOPIC_SCAN = "id_4_scan_interval";
const TOPIC_HEATING_NEEDED = "potreba_zapnout_topeni_termostat_motorkarna_prebytky_z_fve";
const TOPIC_MANUAL_OVERRIDE = "manualni_zapnuti_topeni_v_motorkarne";
const TOPIC_BATTERY_POWER = "stridac_garaz_battery_power";
const TOPIC_BATTERY_SOC = "stridac_garaz_battery";

// 100W buffer - kompenzace chybného odhadu startovního proudu
// (wallbox při startu krátkodobě přetáhne o ~50-150W)
const TURN_ON_BUFFER = 100;

// 10 sekund - ochrana proti flapping při rychlých změnách síťového přebytku
// (slunce za mrakem = -2000W → +2000W → -2000W v řádu sekund)
const PERMISSION_COOLDOWN_MS = 10000;

// Ochrana baterie - prahové hodnoty
const BATTERY_IDLE_THRESHOLD = 50;               // ±50W = baterie idle

// ═══════════════════════════════════════════════════════════════════════════
// STAVOVÝ AUTOMAT — 3 stavy řízení přebytků
// ═══════════════════════════════════════════════════════════════════════════
const STATE_CHARGE_PRIORITY = "CHARGE_PRIORITY";
const STATE_SURPLUS_CONTROL = "SURPLUS_CONTROL";
const STATE_FULL_MODE = "FULL_MODE";

// Cílový export (záporný = export do sítě)
const P_GRID_TARGET = -150;     // W — export 150 W = stabilní buffer
const P_GRID_DEADBAND = 100;      // W — nereagovat na menší odchylky

// ═══════════════════════════════════════════════════════════════════════════
// ODHAD MAX NABÍJECÍHO VÝKONU BATERIE (P_ch_max_est)
// ═══════════════════════════════════════════════════════════════════════════
const P_CH_MAX_DEFAULT = 3000;     // W — výchozí odhad bez dat
const P_CH_MAX_WINDOW_MS = 600000;   // 10 min klouzavé okno
const P_CH_MAX_MIN_SAMPLES = 3;        // Min vzorků pro odhad
const P_CH_MAX_MARGIN = 300;      // W — ochranná marže pro přechod zpět
const P_CH_MAX_RATIO_STABLE = 0.90;     // 90% = nabíjení považováno za stabilní
const CHARGE_PRIORITY_TIMEOUT_MS = 180000;  // 3 min max v CHARGE_PRIORITY s exportem

// ═══════════════════════════════════════════════════════════════════════════
// PROBE TEST — aktivní zjišťování kapacity baterie
// ═══════════════════════════════════════════════════════════════════════════
const PROBE_STEP_W = 600;      // W — krok probe testu
const PROBE_INTERVAL_MS = 300000;   // 5 min minimální interval
const PROBE_INTERVAL_HIGH_SOC_MS = 600000; // 10 min při SOC > 95%
const PROBE_SETTLE_SAMPLES = 2;        // 2 × 5s = 10s ustálení
const PROBE_TOLERANCE = 0.20;     // ±20% tolerance vyhodnocení

// ═══════════════════════════════════════════════════════════════════════════
// PLYNULÁ ZÁTĚŽ — regulace wallboxu / analogové zátěže
// ═══════════════════════════════════════════════════════════════════════════
const ANALOG_STEP_UP = 500;      // W/cyklus — max krok nahoru
const ANALOG_STEP_DOWN = 1000;     // W/cyklus — max krok dolů
const ANALOG_RATE_LIMIT_MS = 10000;    // 10s — max 2 změny

// ═══════════════════════════════════════════════════════════════════════════
// ON/OFF ZÁTĚŽE — hystereze, cooldown, rollback
// ═══════════════════════════════════════════════════════════════════════════
const ONOFF_HYSTERESIS_ON = 200;      // W — přebytek nad nominál pro zapnutí
const ONOFF_HYSTERESIS_OFF = 100;      // W — pod nominál pro vypnutí
const ONOFF_COOLDOWN_OFF_MS = 120000;   // 2 min po vypnutí
const ONOFF_COOLDOWN_ON_MS = 30000;    // 30s po zapnutí
const ONOFF_ROLLBACK_CHECK_MS = 15000;  // 15s — kontrola po zapnutí
const ONOFF_ROLLBACK_P_BAT_DROP = 200;  // W — pokles P_bat pro rollback
const ONOFF_ROLLBACK_COOLDOWN_MS = 180000; // 3 min cooldown po rollbacku

// ═══════════════════════════════════════════════════════════════════════════
// FULL MODE — tolerance vybíjení při plné baterii
// ═══════════════════════════════════════════════════════════════════════════
const FULL_SOC_ENTER = 100;      // SOC pro vstup do FULL
const FULL_SOC_ENTER_ALT = 98;       // SOC + P_bat ≈ 0 = alternativní vstup
const FULL_SOC_EXIT_SURPLUS = 97;       // SOC zpět na SURPLUS_CONTROL
const FULL_SOC_EXIT_CHARGE = 95;       // SOC zpět na CHARGE_PRIORITY
const FULL_DISCHARGE_WARN_MS = 30000;  // 30s — stáhnout plynulou o 50%
const FULL_DISCHARGE_OFF1_MS = 45000;  // 45s — vypnout 1× ON/OFF
const FULL_DISCHARGE_ALL_MS = 60000;  // 60s — vypnout vše

// ═══════════════════════════════════════════════════════════════════════════
// STABILIZACE — požadovaná doba stabilního nabíjení (závisí na SOC)
// ═══════════════════════════════════════════════════════════════════════════
const STABLE_MS_SOC_LOW = 90000;    // 90s — SOC < 50%
const STABLE_MS_SOC_MID = 60000;    // 60s — SOC 50–80%
const STABLE_MS_SOC_HIGH = 30000;    // 30s — SOC 80–98%
const STABLE_MS_SOC_FULL = 10000;    // 10s — SOC ≥ 98%

// ═══════════════════════════════════════════════════════════════════════════
// OPTIMALIZACE VÝKONU
// ═══════════════════════════════════════════════════════════════════════════
const OPERATING_HOUR_START = 6;
const OPERATING_HOUR_END = 22;
const GRID_DEBOUNCE_THRESHOLD = 50;


// ═══════════════════════════════════════════════════════════════════════════
// GENERÁTORY ID ENTIT
// Centrální místo pro generování názvů entit priorit
// ═══════════════════════════════════════════════════════════════════════════
const ENTITY_IDS = {
    prioritySelect: (i) => `input_select.provoz_spotrebice_z_prebytku_priorita_${i}`,
    priorityStatus: (i) => `input_boolean.stav_priority_${i}_provoz_spotrebice_z_prebytku`
};


const ha = global.get('homeassistant.homeAssistant');
if (!ha || !ha.states) return [null, null, null];

function safeState(entityId, defaultVal = "") {
    if (ha.states[entityId] && ha.states[entityId].state !== undefined) return ha.states[entityId].state;
    return defaultVal;
}

function safeAttr(entityId, attrName, defaultVal = 0) {
    if (ha.states[entityId] && ha.states[entityId].attributes && ha.states[entityId].attributes[attrName] !== undefined) return ha.states[entityId].attributes[attrName];
    return defaultVal;
}

function entityExists(entityId) {
    return ha.states[entityId] !== undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// EV CONTEXT HELPERS
// Všechna EV data (battery, cable, online, location) se čtou z context,
// kam je ukládáme z příchozích msg.topic Node-RED bloků.
// ═══════════════════════════════════════════════════════════════════════════

// Získá stav EV senzoru z context
function getEVState(key, defaultVal) {
    let evStates = context.get('evStates') || {};
    if (evStates[key] !== undefined) return evStates[key].value;
    return defaultVal;
}

// Zjistí stáří EV dat v context (v minutách)
function getEVStateAgeMinutes(key) {
    let evStates = context.get('evStates') || {};
    if (!evStates[key] || !evStates[key].timestamp) return Infinity;
    return (Date.now() - evStates[key].timestamp) / (1000 * 60);
}

// Bezpečně vrátí úroveň baterie EV z context
function safeBattery() {
    let raw = getEVState('battery', "50");
    let val = parseFloat(raw);
    if (isNaN(val)) return 50;
    return val;
}

// Zjistí stáří entity v minutách (pro NON-EV entity z ha.states)
function getEntityAgeMinutes(entityId) {
    if (!ha.states[entityId]) return Infinity;
    var entity = ha.states[entityId];
    var lastUpdated = entity.last_updated || entity.last_changed;
    if (!lastUpdated) return Infinity;
    var lastTime = new Date(lastUpdated).getTime();
    if (isNaN(lastTime)) return Infinity;
    return (Date.now() - lastTime) / (1000 * 60);
}

// Kontrola zda jsou EV data čerstvá (battery se nekontroluje)
function isEVDataFresh() {
    var cableAge = getEVStateAgeMinutes('cable');
    var onlineAge = getEVStateAgeMinutes('online');
    var locationAge = getEVStateAgeMinutes('location');
    var maxAge = Math.max(cableAge, onlineAge, locationAge);
    return maxAge <= EV_DATA_MAX_AGE_MINUTES;
}

// ═══════════════════════════════════════════════════════════════════════════
// BATTERY HELPERS — čtení stavu baterie z context
// ═══════════════════════════════════════════════════════════════════════════

// Získá výkon baterie z context (W), kladné = nabíjení, záporné = vybíjení
function getBatteryPower() {
    let val = context.get('batteryPower');
    if (val === undefined || val === null) return 0;
    let num = parseFloat(val);
    return isNaN(num) ? 0 : num;
}

// Získá SOC baterie z context (%)
function getBatterySoc() {
    let val = context.get('batterySoc');
    if (val === undefined || val === null) return 50;
    let num = parseFloat(val);
    return isNaN(num) ? 50 : num;
}

// Kontrola stability přebytku po požadovanou dobu
function isSurplusStable(requiredWatts, durationMs) {
    let history = context.get('surplusHistory') || [];
    if (history.length < 2) return false;

    let stableSince = Date.now() - durationMs;
    let relevantHistory = history.filter(s => s.time >= stableSince);

    // Musí mít alespoň 2 měření v okně
    if (relevantHistory.length < 2) return false;

    // Nejstarší záznam musí pokrývat celou požadovanou dobu
    if (Date.now() - relevantHistory[0].time < durationMs) return false;

    // Všechny hodnoty musí být >= požadovaný výkon
    return relevantHistory.every(s => s.power >= requiredWatts);
}

// Kontrola zda se baterie trvale vybíjí po požadovanou dobu
function isBatteryDischargingSustained(durationMs) {
    let history = context.get('batteryPowerHistory') || [];
    if (history.length < 2) return false;

    let stableSince = Date.now() - durationMs;
    let relevantHistory = history.filter(s => s.time >= stableSince);

    if (relevantHistory.length < 2) return false;
    if (Date.now() - relevantHistory[0].time < durationMs) return false;

    // Všechny hodnoty musí být pod prahem idle (= baterie se reálně vybíjí, ne jen šum)
    return relevantHistory.every(s => s.power < -BATTERY_IDLE_THRESHOLD);
}

// Kontrola zda se baterie stabilně nabíjí po požadovanou dobu
// Účel: nespouštět přebytkové zařízení dokud nabíjení není stabilní
function isBatteryChargingStable(durationMs) {
    let history = context.get('batteryPowerHistory') || [];
    if (history.length < 2) return false;

    let stableSince = Date.now() - durationMs;
    let relevantHistory = history.filter(s => s.time >= stableSince);

    if (relevantHistory.length < 2) return false;
    if (Date.now() - relevantHistory[0].time < durationMs) return false;

    // Všechny hodnoty musí být kladné (= baterie se nabíjí)
    return relevantHistory.every(s => s.power > BATTERY_IDLE_THRESHOLD);
}

// ═══════════════════════════════════════════════════════════════════════════
// P_ch_max_est — odhad maximálního nabíjecího výkonu baterie
// Pasivní: klouzavý percentil 90 % z historie nabíjení bez zátěže přebytků
// ═══════════════════════════════════════════════════════════════════════════

// Aktualizuje ring-buffer vzorků nabíjecího výkonu a vrací odhad P_ch_max
// FIX: ukládá SOC ke každému vzorku a filtruje dle SOC pásma (±15%)
// → odhad pro SOC 90% nevyužívá data z SOC 30% a naopak
function updatePChMaxEst(batteryPower, anySurplusRunning, currentSoc) {
    let samples = context.get('pChMaxSamples') || [];
    let now = Date.now();

    // Přidat vzorek POUZE když žádné surplus zařízení neběží a baterie nabíjí
    if (!anySurplusRunning && batteryPower > BATTERY_IDLE_THRESHOLD) {
        samples.push({ power: batteryPower, time: now, soc: currentSoc });
    }

    // Odfiltrovat staré vzorky
    let cutoff = now - P_CH_MAX_WINDOW_MS;
    samples = samples.filter(s => s.time >= cutoff);
    context.set('pChMaxSamples', samples);

    // Filtrovat na podobný SOC (±15%) — max nabíjení klesá se SOC
    let socLow = Math.max(0, currentSoc - 15);
    let socHigh = Math.min(100, currentSoc + 15);
    let bandSamples = samples.filter(s => s.soc >= socLow && s.soc <= socHigh);

    // Fallback: pokud málo vzorků v pásmu, použít všechny
    let useSamples = (bandSamples.length >= P_CH_MAX_MIN_SAMPLES) ? bandSamples : samples;

    if (useSamples.length < P_CH_MAX_MIN_SAMPLES) {
        // Staleness: pokud odhad starší než 20 min → reset na default
        let lastEstTime = context.get('pChMaxEstTime') || 0;
        if ((now - lastEstTime) > P_CH_MAX_WINDOW_MS * 2) {
            return P_CH_MAX_DEFAULT;
        }
        return context.get('pChMaxEst') || P_CH_MAX_DEFAULT;
    }

    let sorted = useSamples.map(s => s.power).sort((a, b) => a - b);
    let idx = Math.floor(sorted.length * 0.9);
    if (idx >= sorted.length) idx = sorted.length - 1;
    let est = sorted[idx];

    context.set('pChMaxEst', est);
    context.set('pChMaxEstTime', now);
    return est;
}

// Vrací požadovanou dobu stability nabíjení podle SOC
function getRequiredStabilityMs(soc) {
    if (soc >= 100) return 0;
    if (soc >= FULL_SOC_ENTER_ALT) return STABLE_MS_SOC_FULL;    // 10s
    if (soc >= 80) return STABLE_MS_SOC_HIGH;                     // 30s
    if (soc >= 50) return STABLE_MS_SOC_MID;                      // 60s
    return STABLE_MS_SOC_LOW;                                      // 90s
}

// ═══════════════════════════════════════════════════════════════════════════
// STAVOVÝ AUTOMAT — přechody mezi CHARGE_PRIORITY / SURPLUS_CONTROL / FULL_MODE
// ═══════════════════════════════════════════════════════════════════════════

function updateFsmState(currentState, batteryPower, batterySoc, pChMaxEst, availablePower) {
    let now = Date.now();

    switch (currentState) {
        case STATE_CHARGE_PRIORITY: {
            // Přechod na FULL_MODE: baterie plně nabitá
            if (batterySoc >= FULL_SOC_ENTER) {
                context.set('fullDischargeStart', null);
                context.set('chargePriorityEntry', null);
                return STATE_FULL_MODE;
            }
            // Alternativní vstup do FULL: SOC >= 98% a baterie idle/nenabíjí
            // FIX: tolerance 200W místo 50W — trickle charge při vysokém SOC neblokuje FULL_MODE
            if (batterySoc >= FULL_SOC_ENTER_ALT && Math.abs(batteryPower) <= 200) {
                context.set('fullDischargeStart', null);
                context.set('chargePriorityEntry', null);
                return STATE_FULL_MODE;
            }

            // Přechod na SURPLUS_CONTROL: nabíjení stabilní + je přebytek
            let reqStability = getRequiredStabilityMs(batterySoc);
            let chargingOk = (reqStability === 0) || isBatteryChargingStable(reqStability);
            let batNearMax = (pChMaxEst > 0) ? (batteryPower >= pChMaxEst * P_CH_MAX_RATIO_STABLE) : true;
            let hasExport = (availablePower > P_GRID_DEADBAND);
            // Pokud baterie nenabíjí (idle/plná) a je export → povolíme přebytky
            let batNotCharging = (batteryPower <= BATTERY_IDLE_THRESHOLD && availablePower > 0);
            // FIX: Pokud je velký export (>500W) a baterie NABÍJÍ (jakkoliv),
            // BMS limituje nabíjení a zbytek teče do sítě → pustit přebytky
            let bigExportAndCharging = (availablePower > 500 && batteryPower > BATTERY_IDLE_THRESHOLD && chargingOk);
            // FIX: SOC vysoký (≥95%) + velký export + baterie se nevybíjí
            // → BMS zastavilo nabíjení, přebytek teče do sítě zbytečně
            let highSocBigExport = (batterySoc >= 95 && availablePower > 500 && batteryPower >= -BATTERY_IDLE_THRESHOLD);

            if ((chargingOk && batNearMax && hasExport) || batNotCharging || bigExportAndCharging || highSocBigExport) {
                context.set('chargePriorityEntry', null);
                return STATE_SURPLUS_CONTROL;
            }

            // Timeout: pokud jsme v CHARGE_PRIORITY příliš dlouho s exportem
            // Ochrana proti zaseknutí kvůli špatnému odhadu pChMaxEst
            let cpEntry = context.get('chargePriorityEntry');
            if (availablePower > 200) {
                if (!cpEntry) {
                    context.set('chargePriorityEntry', now);
                } else if ((now - cpEntry) >= CHARGE_PRIORITY_TIMEOUT_MS) {
                    context.set('chargePriorityEntry', null);
                    return STATE_SURPLUS_CONTROL;
                }
            } else {
                context.set('chargePriorityEntry', null);
            }

            return STATE_CHARGE_PRIORITY;
        }

        case STATE_SURPLUS_CONTROL: {
            // Přechod na FULL_MODE: baterie plně nabitá
            if (batterySoc >= FULL_SOC_ENTER) {
                context.set('fullDischargeStart', null);
                return STATE_FULL_MODE;
            }
            // FIX: tolerance 200W místo 50W — trickle charge při vysokém SOC neblokuje FULL_MODE
            if (batterySoc >= FULL_SOC_ENTER_ALT && Math.abs(batteryPower) <= 200) {
                context.set('fullDischargeStart', null);
                return STATE_FULL_MODE;
            }

            // Přechod zpět na CHARGE_PRIORITY: baterie se trvale vybíjí
            // Ochrana proti flapping: vyžaduje 3× po sobě (≈15s) pod prahem
            if (batteryPower < -BATTERY_IDLE_THRESHOLD) {
                let dischargeCount = (context.get('surplusDischargeCount') || 0) + 1;
                context.set('surplusDischargeCount', dischargeCount);
                if (dischargeCount >= 3) {
                    context.set('surplusDischargeCount', 0);
                    return STATE_CHARGE_PRIORITY;
                }
            } else {
                context.set('surplusDischargeCount', 0);
            }

            // Přechod zpět: nabíjení výrazně pokleslo pod odhad maxima
            if (batteryPower > BATTERY_IDLE_THRESHOLD && pChMaxEst > 0) {
                if (batteryPower < pChMaxEst - P_CH_MAX_MARGIN) {
                    // Počítat kolik cyklů v řadě je deficit
                    let deficitCount = (context.get('chargeDeficitCount') || 0) + 1;
                    context.set('chargeDeficitCount', deficitCount);
                    if (deficitCount >= 2) {  // 2× po sobě (10s) → zpět
                        context.set('chargeDeficitCount', 0);
                        return STATE_CHARGE_PRIORITY;
                    }
                } else {
                    context.set('chargeDeficitCount', 0);
                }
            } else {
                context.set('chargeDeficitCount', 0);
            }

            return STATE_SURPLUS_CONTROL;
        }

        case STATE_FULL_MODE: {
            // Přechod na CHARGE_PRIORITY: SOC výrazně poklesl
            if (batterySoc < FULL_SOC_EXIT_CHARGE) {
                context.set('fullDischargeStart', null);
                return STATE_CHARGE_PRIORITY;
            }
            // Přechod na SURPLUS_CONTROL: SOC mírně poklesl
            if (batterySoc < FULL_SOC_EXIT_SURPLUS) {
                context.set('fullDischargeStart', null);
                return STATE_SURPLUS_CONTROL;
            }
            return STATE_FULL_MODE;
        }

        default:
            return STATE_CHARGE_PRIORITY;
    }
}

// Vrací akci pro FULL_MODE na základě doby vybíjení
// Vrací: "ok" | "reduce_analog" | "off_one" | "off_all"
function getFullModeDischargeAction(batteryPower) {
    let now = Date.now();
    let dischargeStart = context.get('fullDischargeStart');

    if (batteryPower < -BATTERY_IDLE_THRESHOLD) {
        // Baterie se vybíjí
        if (!dischargeStart) {
            context.set('fullDischargeStart', now);
            return "ok";
        }
        let elapsed = now - dischargeStart;
        if (elapsed >= FULL_DISCHARGE_ALL_MS) return "off_all";
        if (elapsed >= FULL_DISCHARGE_OFF1_MS) return "off_one";
        if (elapsed >= FULL_DISCHARGE_WARN_MS) return "reduce_analog";
        return "ok";
    } else {
        // Vybíjení se zastavilo → reset timeru
        context.set('fullDischargeStart', null);
        return "ok";
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROBE TEST — aktivní zjišťování max nabíjecího výkonu
// ═══════════════════════════════════════════════════════════════════════════

// Zkontroluje zda pustit probe a vrací stav probe
function updateProbeState(batteryPower, batterySoc, fsmState, priorityQueue) {
    let probeState = context.get('probeState') || { active: false, lastProbe: 0 };
    let now = Date.now();

    // Probe POUZE v SURPLUS_CONTROL
    if (fsmState !== STATE_SURPLUS_CONTROL) {
        if (probeState.active) {
            // Abort probe — systém opustil SURPLUS
            probeState.active = false;
            context.set('probeState', probeState);
        }
        return probeState;
    }

    // Pokud probe běží, vyhodnotit výsledky
    if (probeState.active) {
        probeState.settleCount = (probeState.settleCount || 0) + 1;

        if (probeState.settleCount >= PROBE_SETTLE_SAMPLES) {
            // Vyhodnotit probe
            let deltaBat = batteryPower - probeState.pBatBefore;
            let pChMaxEst = context.get('pChMaxEst') || P_CH_MAX_DEFAULT;

            if (deltaBat >= PROBE_STEP_W * (1 - PROBE_TOLERANCE)) {
                // Scénář A: baterie přijala uvolněný výkon → není na maximu
                pChMaxEst = Math.max(pChMaxEst, batteryPower);
            } else if (deltaBat <= PROBE_STEP_W * PROBE_TOLERANCE) {
                // Scénář B: výkon šel do exportu → baterie na limitu
                pChMaxEst = probeState.pBatBefore;
            } else {
                // Scénář C: částečně → P_ch_max = aktuální P_bat
                pChMaxEst = batteryPower;
            }

            context.set('pChMaxEst', pChMaxEst);
            probeState.active = false;
            probeState.lastProbe = now;
            probeState.reduceAmount = 0;
            context.set('probeState', probeState);
        } else {
            context.set('probeState', probeState);
        }
        return probeState;
    }

    // Kontrola zda spustit nový probe
    let interval = (batterySoc > 95) ? PROBE_INTERVAL_HIGH_SOC_MS : PROBE_INTERVAL_MS;
    if (now - probeState.lastProbe < interval) return probeState;

    // Podmínky pro spuštění
    let evDevice = priorityQueue.find(pq => pq.device.isEV && pq.isRunning);
    let hasAnalogRunning = !!evDevice;
    if (!hasAnalogRunning) return probeState; // Není co stáhnout

    let currentWatts = evDevice ? evDevice.currentWatts : 0;
    if (currentWatts < PROBE_STEP_W + 500) return probeState; // Příliš malý výkon

    // Kontrola stability P_bat (rozptyl < 200W v posledních 30s)
    let bpHist = context.get('batteryPowerHistory') || [];
    let recent = bpHist.filter(s => s.time >= now - 30000);
    if (recent.length < 4) return probeState;
    let minP = Math.min(...recent.map(s => s.power));
    let maxP = Math.max(...recent.map(s => s.power));
    if (maxP - minP > 200) return probeState; // Příliš nestabilní

    // Kontrola zda nebyla nedávno ON/OFF změna
    let lastOnOffChange = context.get('lastOnOffChangeTime') || 0;
    if (now - lastOnOffChange < 30000) return probeState;

    // Spustit probe!
    probeState.active = true;
    probeState.settleCount = 0;
    probeState.pBatBefore = batteryPower;
    probeState.reduceAmount = PROBE_STEP_W;
    context.set('probeState', probeState);

    return probeState;
}

// ═══════════════════════════════════════════════════════════════════════════
// ON/OFF ROLLBACK — kontrola po zapnutí zařízení
// ═══════════════════════════════════════════════════════════════════════════

function checkOnOffRollbacks(batteryPower, currentGrid) {
    let rollbacks = context.get('onoffRollbacks') || {};
    let now = Date.now();
    let rollbackActions = []; // pole permission entity k vypnutí

    for (let perm in rollbacks) {
        let rb = rollbacks[perm];
        if (now - rb.timestamp >= ONOFF_ROLLBACK_CHECK_MS) {
            // Čas na vyhodnocení
            let pBatDrop = rb.pBatBefore - batteryPower;
            let importing = (currentGrid > 100); // import ze sítě

            if (pBatDrop > ONOFF_ROLLBACK_P_BAT_DROP || importing) {
                // ROLLBACK — baterie poklesla nebo importujeme
                rollbackActions.push(perm);
                // Nastavit rollback cooldown
                let permCooldowns = context.get('permCooldowns') || {};
                permCooldowns[perm] = now + ONOFF_ROLLBACK_COOLDOWN_MS - PERMISSION_COOLDOWN_MS;
                context.set('permCooldowns', permCooldowns);
            }
            delete rollbacks[perm];
        }
    }

    context.set('onoffRollbacks', rollbacks);
    return rollbackActions;
}

// Vrací zamrzlou hodnotu input_select pokud je servisní režim aktivní, jinak aktuální hodnotu
function getFrozenOrCurrentSelect(selectId, frozenConfig, isServiceMode) {
    if (isServiceMode && frozenConfig && frozenConfig.selects && frozenConfig.selects[selectId] !== undefined) {
        return frozenConfig.selects[selectId];
    }
    return safeState(selectId);
}

// Vrací zamrzlou hodnotu vypínače priority pokud je servisní režim aktivní, jinak aktuální hodnotu
function getFrozenOrCurrentSwitch(switchId, frozenConfig, isServiceMode) {
    if (isServiceMode && frozenConfig && frozenConfig.switches && frozenConfig.switches[switchId] !== undefined) {
        return frozenConfig.switches[switchId];
    }
    return safeState(switchId, "off");
}

function getDeviceRunningState(devConfig, triggerTopic, triggerPayload) {
    if (!devConfig) return false;

    let realState;
    // Pokud zpráva přišla přímo od tohoto zařízení, použij payload místo ha.states
    if (triggerTopic === devConfig.entity) {
        realState = String(triggerPayload);
    } else {
        realState = safeState(devConfig.entity);
    }

    let isDeviceOn = (realState === "on" || realState === "true" || realState === "heating" || realState === "charging");

    if (devConfig.isEV) {
        let permState = safeState(devConfig.permission);
        let brightness = safeAttr(devConfig.entity, "brightness", 0);
        isDeviceOn = (permState === "on" && brightness >= devConfig.minBrightness);
    }

    return isDeviceOn;
}

let t = msg.topic;

// ═══════════════════════════════════════════════════════════════════════════
// EARLY EXIT OPTIMALIZACE - rychlé ukončení pro úsporu výkonu
// ═══════════════════════════════════════════════════════════════════════════

// 1. Noční režim - mimo provozní hodiny přeskočit (FVE nevyrábí)
let currentHour = new Date().getHours();
if (currentHour < OPERATING_HOUR_START || currentHour >= OPERATING_HOUR_END) {
    return [null, null, null];
}

// 2. Debounce grid sensoru - ignorovat malé změny
// DŮLEŽITÉ: I při debounce se aktualizuje surplusHistory,
// aby isSurplusStable() měla dost dat i při stabilním přebytku
if (t === GRID_SENSOR || t === TOPIC_GRID) {
    let lastGridValue = context.get('lastGridValue') || 0;
    let currentGridValue = parseFloat(msg.payload);
    if (!isNaN(currentGridValue)) {
        // Vždy aktualizovat historii přebytku (pro stabilizaci zapínání)
        let availPwr = currentGridValue * -1;
        let surplusHistory = context.get('surplusHistory') || [];
        surplusHistory.push({ power: availPwr, time: Date.now() });
        let cutoff = Date.now() - 90000;
        surplusHistory = surplusHistory.filter(s => s.time >= cutoff);
        context.set('surplusHistory', surplusHistory);

        if (Math.abs(currentGridValue - lastGridValue) < GRID_DEBOUNCE_THRESHOLD) {
            // Malá změna — přepočítat alespoň každých 30s
            let lastFullRecalc = context.get('lastFullRecalcTime') || 0;
            if (Date.now() - lastFullRecalc < 30000) {
                return [null, null, null];
            }
        }
        context.set('lastGridValue', currentGridValue);
        context.set('lastFullRecalcTime', Date.now());
    }
}

if (t && t.includes("stav_priority")) {
    return [null, null, null];
}

// ═══════════════════════════════════════════════════════════════════════════
// UKLÁDÁNÍ EV STAVŮ DO CONTEXT z příchozích msg.topic Node-RED bloků
// "unavailable"/"unknown" se NEUKLÁDAJÍ — neplatný stav z API nepřepisuje
// ═══════════════════════════════════════════════════════════════════════════
{
    let evStates = context.get('evStates') || {};
    let evUpdated = false;
    let val = String(msg.payload).toLowerCase();
    // Ignorovat neplatné stavy z API
    let isInvalid = (val === "unavailable" || val === "unknown" || val === "nan" || val === "null" || val === "undefined");

    if (t === TOPIC_CABLE && !isInvalid) {
        evStates.cable = { value: String(msg.payload), timestamp: Date.now() };
        evUpdated = true;
    }
    if (t === TOPIC_ONLINE && !isInvalid) {
        evStates.online = { value: String(msg.payload), timestamp: Date.now() };
        evUpdated = true;
    }
    if (t === TOPIC_LOCATION && !isInvalid) {
        evStates.location = { value: String(msg.payload), timestamp: Date.now() };
        evUpdated = true;
    }
    if (t === TOPIC_BATTERY && !isInvalid) {
        evStates.battery = { value: String(msg.payload), timestamp: Date.now() };
        evUpdated = true;
    }
    if (evUpdated) context.set('evStates', evStates);
}

// ═══════════════════════════════════════════════════════════════════════════
// UKLÁDÁNÍ STAVU BATERIE DO CONTEXT
// ═══════════════════════════════════════════════════════════════════════════
{
    if (t === TOPIC_BATTERY_POWER) {
        let val = parseFloat(msg.payload);
        if (!isNaN(val)) {
            // Klouzavý průměr — vyhlazuje šum ze senzoru (3 vzorky)
            let bpSamples = context.get('batteryPowerSamples') || [];
            bpSamples.push(val);
            if (bpSamples.length > 3) bpSamples.shift();
            context.set('batteryPowerSamples', bpSamples);
            let avg = bpSamples.reduce((a, b) => a + b, 0) / bpSamples.length;
            context.set('batteryPower', avg);
        }
    }
    if (t === TOPIC_BATTERY_SOC) {
        let val = parseFloat(msg.payload);
        if (!isNaN(val)) {
            context.set('batterySoc', val);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EARLY EXIT pro EV info triggery
// EV senzory jen ukládají data do context — plný přepočet dělá grid trigger
// VÝJIMKA: TOPIC_CABLE a TOPIC_LOCATION triggrují plný přepočet
// (aby připojení kabelu / příjezd domů okamžitě vyhodnotily přebytky)
// ═══════════════════════════════════════════════════════════════════════════
{
    let evInfoTopics = [TOPIC_BATTERY, TOPIC_ONLINE, TOPIC_POWER, TOPIC_SCAN];
    if (evInfoTopics.includes(t)) {
        return [null, null, null];
    }
}

let statusMessages = [];
let permissionMessages = [];
let scanIntervalMessages = [];

let isTriggerValid = false;

if (t === GRID_SENSOR || t === TOPIC_GRID) isTriggerValid = true;
if (t === MANUAL_CHARGE_ENTITY || t === TOPIC_MANUAL) isTriggerValid = true;
if (t === SYSTEM_SWITCH_ENTITY || t === TOPIC_SYSTEM) isTriggerValid = true;
if (t === SERVICE_MODE_ENTITY || t === TOPIC_SERVICE) isTriggerValid = true;
if (t === EV_BATTERY || t === TOPIC_BATTERY) isTriggerValid = true;
if (t === EV_CABLE || t === TOPIC_CABLE) isTriggerValid = true;
if (t === EV_POWER || t === TOPIC_POWER) isTriggerValid = true;
if (t === EV_ONLINE || t === TOPIC_ONLINE) isTriggerValid = true;
if (t === EV_LOCATION || t === TOPIC_LOCATION) isTriggerValid = true;
if (t === SCAN_INTERVAL_ENTITY || t === TOPIC_SCAN) isTriggerValid = true;
if (t === TOPIC_HEATING_NEEDED) isTriggerValid = true;
if (t === TOPIC_MANUAL_OVERRIDE) isTriggerValid = true;
if (t === TOPIC_BATTERY_POWER) isTriggerValid = true;
if (t === TOPIC_BATTERY_SOC) isTriggerValid = true;

let triggeredDevice = devices.find(d => d.entity === t);
// Zkusit najít i podle zkráceného názvu (bez domény switch., light. atd.)
if (!triggeredDevice) {
    triggeredDevice = devices.find(d => {
        let shortEntity = d.entity.split('.')[1]; // např. "nous_smart_plug_d1z_16a_spinac"
        return t === shortEntity || t.endsWith(shortEntity);
    });
}
if (triggeredDevice) isTriggerValid = true;

let triggeredByPermission = devices.find(d => d.permission === t);
if (triggeredByPermission) isTriggerValid = true;

// Kontrola zda zpráva přišla od vypínače priority
let triggeredByPrioritySwitch = PRIORITY_SWITCHES.includes(t) ||
    PRIORITY_SWITCHES.some(ps => t === ps.replace("input_boolean.", ""));
if (triggeredByPrioritySwitch) isTriggerValid = true;

if (!isTriggerValid) return [null, null, null];

// === NEZÁVISLÁ LOGIKA STAVŮ PRIORIT ===
// Když přijde zpráva od reálného zařízení a systém je zapnutý, okamžitě aktualizovat stav priority
let isSystemOn = safeState(SYSTEM_SWITCH_ENTITY) === "on";
let isManualChargeOn = safeState(MANUAL_CHARGE_ENTITY) === "on";
let isServiceModeOn = safeState(SERVICE_MODE_ENTITY) === "on";

// === OKAMŽITÁ REAKCE NA MANUÁLNÍ NABÍJENÍ ===
// Když se zapne manuální nabíjení, okamžitě vypnout povolenku ID.4
if ((t === MANUAL_CHARGE_ENTITY || t === TOPIC_MANUAL) && isManualChargeOn && isSystemOn) {
    let evDevice = devices.find(d => d.isEV);
    if (evDevice) {
        let currentPerm = safeState(evDevice.permission, "off");
        if (currentPerm === "on") {
            // Aktualizovat context pro správné fungování cooldownu
            let lastPerms = context.get('lastPerms') || {};
            let permCooldowns = context.get('permCooldowns') || {};
            lastPerms[evDevice.permission] = "off";
            permCooldowns[evDevice.permission] = Date.now();
            context.set('lastPerms', lastPerms);
            context.set('permCooldowns', permCooldowns);
            return [null, [{ topic: evDevice.permission, payload: "off" }], null];
        }
    }
}
// === KONEC OKAMŽITÉ REAKCE NA MANUÁLNÍ NABÍJENÍ ===

// Aktualizace stavů priorit i po vypnutí systému/servisu — stav priority
// se vypne až po reálném vypnutí zařízení, ne okamžitě při vypnutí systému
if (triggeredDevice && !isServiceModeOn) {
    let lastStates = context.get('lastStates') || {};
    let priorityStatusMessages = [];

    // Zjistit stav z payloadu - může být string nebo objekt
    let triggerState;
    if (typeof msg.payload === "object" && msg.payload !== null) {
        triggerState = msg.payload.state || msg.payload.new_state?.state || String(msg.payload);
    } else {
        triggerState = String(msg.payload);
    }

    for (let i = 1; i <= 4; i++) {
        let selectId = ENTITY_IDS.prioritySelect(i);
        let statusTopic = ENTITY_IDS.priorityStatus(i);
        let prioritySwitchId = PRIORITY_SWITCHES[i - 1];

        // Pokud je vypínač priority vypnutý, stav je vždy off
        let isPrioritySwitchOn = safeState(prioritySwitchId, "off") === "on";
        if (!isPrioritySwitchOn) {
            if (lastStates[statusTopic] !== "off") {
                lastStates[statusTopic] = "off";
                priorityStatusMessages.push({ topic: statusTopic, payload: "off" });
            }
            continue;
        }

        let assignedDeviceName = safeState(selectId);
        let devConfig = devices.find(d => d.name === assignedDeviceName);

        // Zjistit reálný stav zařízení A povolenku
        let isDeviceOn = false;
        let hasPermission = false;

        if (devConfig) {
            // Zkontrolovat povolenku
            hasPermission = safeState(devConfig.permission, "off") === "on";

            // Pro EV speciální podmínky
            if (devConfig.isEV) {
                // Pokud je manuální nabíjení nebo baterie 100%, stav priority je off
                let bat = safeBattery();
                if (isManualChargeOn || bat >= 100) {
                    hasPermission = false;
                }
            }

            let realState;
            if (t === devConfig.entity || (triggeredDevice && triggeredDevice.entity === devConfig.entity)) {
                // Použít stav ze zprávy pro zařízení které zprávu vyvolalo
                realState = triggerState;
            } else {
                realState = safeState(devConfig.entity);
            }
            isDeviceOn = (realState === "on" || realState === "true" || realState === "heating" || realState === "charging");

            // Pro EV speciální logika
            if (devConfig.isEV) {
                let brightness = safeAttr(devConfig.entity, "brightness", 0);
                isDeviceOn = (brightness >= devConfig.minBrightness);
            }
        }

        // Stav priority = zařízení reálně běží
        let newPayload = isDeviceOn ? "on" : "off";

        // Odeslat pouze pokud se změnil
        if (lastStates[statusTopic] !== newPayload) {
            lastStates[statusTopic] = newPayload;
            priorityStatusMessages.push({ topic: statusTopic, payload: newPayload });
        }
    }

    context.set('lastStates', lastStates);

    // Vrátit pouze změněné stavy priorit
    if (priorityStatusMessages.length > 0) {
        return [priorityStatusMessages, null, null];
    }
    return [null, null, null];
}
// === KONEC NEZÁVISLÉ LOGIKY STAVŮ PRIORIT ===

// isServiceModeOn již definováno výše

// Pokud je systém vypnutý, ignoruj VŠECHNY zprávy
// Pouze si zapamatujeme stav systému pro detekci zapnutí
let isSystemSwitchMessage = (t === SYSTEM_SWITCH_ENTITY || t === TOPIC_SYSTEM);

let lastSystemOn = context.get('lastSystemOn');
let lastServiceMode = context.get('lastServiceMode');

// Detekce změn stavu
let systemJustTurnedOff = (lastSystemOn === true && isSystemOn === false);
let systemJustTurnedOn = (lastSystemOn === false && isSystemOn === true);
let serviceModeJustTurnedOff = (lastServiceMode === true && isServiceModeOn === false);
let serviceModeJustTurnedOn = (lastServiceMode === false && isServiceModeOn === true);

// Pokud je systém vypnutý
if (!isSystemOn) {
    // Pokud to není zpráva o přepnutí systému, úplně ignoruj
    if (!isSystemSwitchMessage) {
        return [null, null, null];
    }
    // Pokud je to zpráva o přepnutí a systém je stále vypnutý (ne přechod na zapnuto),
    // jen aktualizujeme stav a končíme
    if (lastSystemOn !== true) {
        context.set('lastSystemOn', false);
        return [null, null, null];
    }
    // Pokud lastSystemOn bylo true a teď je false, znamená to právě vypnutí - to zpracujeme níže
}

let lastStates = context.get('lastStates') || {};
let lastPerms = context.get('lastPerms') || {};
let lastScanInterval = context.get('lastScanInterval');

let isFirstRun = (lastSystemOn === undefined);

if (isFirstRun) {
    for (let i = 1; i <= 4; i++) {
        let statusId = ENTITY_IDS.priorityStatus(i);
        lastStates[statusId] = safeState(statusId, "off");
    }

    for (let device of devices) {
        lastPerms[device.permission] = safeState(device.permission, "off");
    }

    lastScanInterval = parseFloat(safeState(SCAN_INTERVAL_ENTITY, SCAN_SLOW));
    lastServiceMode = isServiceModeOn;
    lastSystemOn = isSystemOn;

    context.set('lastStates', lastStates);
    context.set('lastPerms', lastPerms);
    context.set('lastScanInterval', lastScanInterval);
    context.set('lastServiceMode', lastServiceMode);
    context.set('lastSystemOn', lastSystemOn);

    // Pokud je při prvním běhu systém vypnutý, nic nedělej
    if (!isSystemOn) {
        return [null, null, null];
    }
}

// Načíst nebo vytvořit zamrzlou konfiguraci pro servisní režim
var frozenConfig = context.get('frozenConfig') || null;

// Při zapnutí servisního režimu zamrazit aktuální konfiguraci
if (serviceModeJustTurnedOn) {
    frozenConfig = {
        selects: {},
        switches: {}
    };
    // Uložit aktuální hodnoty input_select pro každou prioritu
    for (var i = 1; i <= 4; i++) {
        var selectId = ENTITY_IDS.prioritySelect(i);
        frozenConfig.selects[selectId] = safeState(selectId);
    }
    // Uložit aktuální hodnoty vypínačů priorit
    for (var j = 0; j < PRIORITY_SWITCHES.length; j++) {
        frozenConfig.switches[PRIORITY_SWITCHES[j]] = safeState(PRIORITY_SWITCHES[j], "off");
    }
    context.set('frozenConfig', frozenConfig);
}

// Funkce pro porovnání zda se změnilo pořadí priorit
function isPriorityOrderChanged(frozen) {
    if (!frozen || !frozen.selects || !frozen.switches) {
        return false; // Nemáme co porovnat
    }

    // Porovnat input_select pro každou prioritu (pořadí zařízení)
    for (var i = 1; i <= 4; i++) {
        var selectId = ENTITY_IDS.prioritySelect(i);
        var frozenValue = frozen.selects[selectId];
        var currentValue = safeState(selectId);

        if (frozenValue !== currentValue) {
            return true; // Pořadí se změnilo
        }
    }

    // Porovnat vypínače priorit (zda jsou zapnuté/vypnuté)
    for (var j = 0; j < PRIORITY_SWITCHES.length; j++) {
        var switchId = PRIORITY_SWITCHES[j];
        var frozenSwitch = frozen.switches[switchId];
        var currentSwitch = safeState(switchId, "off");

        if (frozenSwitch !== currentSwitch) {
            return true; // Konfigurace vypínačů se změnila
        }
    }

    return false; // Nic se nezměnilo
}

// Při vypnutí servisního režimu - zjistit zda je potřeba reset
let needsResetOnServiceModeOff = false;
if (serviceModeJustTurnedOff) {
    // Porovnat zamrzlou konfiguraci s aktuální
    needsResetOnServiceModeOff = isPriorityOrderChanged(frozenConfig);

    // Vždy smazat zamrzlou konfiguraci
    frozenConfig = null;
    context.set('frozenConfig', null);
}

// Reset při: vypnutí systému, zapnutí systému, nebo vypnutí servisního režimu SE ZMĚNOU PRIORIT
if (systemJustTurnedOff || systemJustTurnedOn || needsResetOnServiceModeOff) {
    // Vypnout pouze povolenky které jsou zapnuté
    for (let device of devices) {
        let currentState = safeState(device.permission, "off");
        if (currentState === "on") {
            permissionMessages.push({
                topic: device.permission,
                payload: "off"
            });
        }
        lastPerms[device.permission] = "off";
    }

    // Nastavit scan interval na pomalý pouze pokud není
    let currentScanInterval = parseFloat(safeState(SCAN_INTERVAL_ENTITY, SCAN_SLOW));
    if (currentScanInterval !== SCAN_SLOW) {
        scanIntervalMessages.push({
            topic: "ev_scan_interval",
            payload: SCAN_SLOW
        });
    }
    lastScanInterval = SCAN_SLOW;

    // Stavy priorit se NERESETUJÍ okamžitě — vypnou se až když
    // se zařízení reálně vypne (přes trigger od entity zařízení na řádku 376+)

    context.set('lastStates', lastStates);
    context.set('lastPerms', lastPerms);
    context.set('lastScanInterval', lastScanInterval);
    context.set('lastServiceMode', isServiceModeOn);
    context.set('lastSystemOn', isSystemOn);

    // Vrátit pouze pokud jsou nějaké zprávy k odeslání
    let hasMessages = (statusMessages.length > 0 || permissionMessages.length > 0 || scanIntervalMessages.length > 0);
    if (hasMessages) {
        return [
            statusMessages.length > 0 ? statusMessages : null,
            permissionMessages.length > 0 ? permissionMessages : null,
            scanIntervalMessages.length > 0 ? scanIntervalMessages : null
        ];
    }
    return [null, null, null];
}

context.set('lastServiceMode', isServiceModeOn);
context.set('lastSystemOn', isSystemOn);

for (let i = 1; i <= 4; i++) {
    let selectId = ENTITY_IDS.prioritySelect(i);
    let statusTopic = ENTITY_IDS.priorityStatus(i);
    let prioritySwitchId = PRIORITY_SWITCHES[i - 1];

    // Pokud je vypínač priority vypnutý, stav je vždy off
    let isPrioritySwitchOn = getFrozenOrCurrentSwitch(prioritySwitchId, frozenConfig, isServiceModeOn) === "on";
    if (!isPrioritySwitchOn) {
        statusMessages.push({
            topic: statusTopic,
            payload: "off"
        });
        continue;
    }

    let assignedDeviceName = getFrozenOrCurrentSelect(selectId, frozenConfig, isServiceModeOn);
    let devConfig = devices.find(d => d.name === assignedDeviceName);

    let isDeviceOn = getDeviceRunningState(devConfig, t, msg.payload);
    let hasPermission = devConfig ? (safeState(devConfig.permission, "off") === "on") : false;

    // Pro EV speciální podmínky
    if (devConfig && devConfig.isEV) {
        let bat = safeBattery();
        if (isManualChargeOn || bat >= 100) {
            hasPermission = false;
        }
    }

    // Stav priority = zařízení reálně běží
    statusMessages.push({
        topic: statusTopic,
        payload: isDeviceOn ? "on" : "off"
    });
}

if (triggeredDevice || triggeredByPermission || triggeredByPrioritySwitch) {
    let finalStatusMessages = [];
    for (let m of statusMessages) {
        if (lastStates[m.topic] !== m.payload) {
            lastStates[m.topic] = m.payload;
            finalStatusMessages.push({ topic: m.topic, payload: m.payload });
        }
    }
    context.set('lastStates', lastStates);

    if (finalStatusMessages.length > 0) {
        return [finalStatusMessages, null, null];
    }
}

if (!isSystemOn || isServiceModeOn) {
    let finalStatusMessages = [];
    for (let m of statusMessages) {
        if (m.forceUpdate || lastStates[m.topic] !== m.payload) {
            lastStates[m.topic] = m.payload;
            finalStatusMessages.push({ topic: m.topic, payload: m.payload });
        }
    }
    context.set('lastStates', lastStates);
    return [finalStatusMessages, null, null];
}

let currentGrid = parseFloat(msg.payload);
if (t !== GRID_SENSOR && t !== TOPIC_GRID) {
    currentGrid = parseFloat(safeState(GRID_SENSOR, "0"));
}
if (isNaN(currentGrid)) currentGrid = 0;

let availablePower = currentGrid * -1;

// Sledování historie přebytku pro stabilizaci zapínání
// Grid sensor již aktualizuje surplusHistory v debounce bloku (řádky výše),
// aby se data ukládala i při malých změnách. Zde jen pro non-grid triggery.
if (t !== GRID_SENSOR && t !== TOPIC_GRID) {
    let surplusHistory = context.get('surplusHistory') || [];
    surplusHistory.push({ power: availablePower, time: Date.now() });
    // Uchovávat jen posledních 90 sekund (buffer nad max stabilizaci 60s)
    let cutoff = Date.now() - 90000;
    surplusHistory = surplusHistory.filter(s => s.time >= cutoff);
    context.set('surplusHistory', surplusHistory);
}

let isEVDataAvailable = true;

// Kontrola dostupnosti EV dat z context (z Node-RED bloků)
if (getEVState('battery', undefined) === undefined) {
    isEVDataAvailable = false;
} else if (getEVState('cable', undefined) === undefined) {
    isEVDataAvailable = false;
} else if (getEVState('online', undefined) === undefined) {
    isEVDataAvailable = false;
} else if (getEVState('location', undefined) === undefined) {
    isEVDataAvailable = false;
}

if (isEVDataAvailable) {
    let onlineState = getEVState('online', 'off');
    // Blokovat POUZE pokud je definitivně offline
    if (onlineState === "off" || onlineState === "false") {
        isEVDataAvailable = false;
    }
}

let priorityQueue = [];

for (let i = 1; i <= 4; i++) {
    let selectId = ENTITY_IDS.prioritySelect(i);
    let statusId = ENTITY_IDS.priorityStatus(i);
    let prioritySwitchId = PRIORITY_SWITCHES[i - 1];

    // Pokud je vypínač priority vypnutý, přeskočit tuto prioritu
    let isPrioritySwitchOn = getFrozenOrCurrentSwitch(prioritySwitchId, frozenConfig, isServiceModeOn) === "on";
    if (!isPrioritySwitchOn) {
        continue;
    }

    let devName = getFrozenOrCurrentSelect(selectId, frozenConfig, isServiceModeOn);
    let devConfig = devices.find(d => d.name === devName);

    if (devConfig) {
        let isReallyRunning = getDeviceRunningState(devConfig, t, msg.payload);

        let currentPermState = safeState(devConfig.permission, "off");
        let hasPermission = (currentPermState === "on");

        let canRunEV = true;

        if (devConfig.isEV) {
            if (isManualChargeOn) {
                canRunEV = false;
            } else if (!isEVDataAvailable) {
                canRunEV = false;
            } else if (!isEVDataFresh()) {
                canRunEV = false;
            } else {
                let loc = getEVState('location', '');
                let cable = getEVState('cable', '');
                let bat = safeBattery();

                let isHome = (String(loc).toLowerCase() === "home" || String(loc).toLowerCase() === "doma");
                let cableStr = String(cable).toLowerCase();
                let isCableConnected = (cableStr === "true" || cableStr === "on" || cableStr === "connected");
                let isNotFull = (bat < 100);

                if (!isHome || !isCableConnected || !isNotFull) {
                    canRunEV = false;
                }
            }
        }

        // Kontrola pojistky pro vytápění (heatingNeeded)
        let canRunHeating = true;
        if (devConfig.heatingNeeded) {
            // Získat aktuální stav termostatu - priorita:
            // 1. Zpráva od termostatu (msg.payload)
            // 2. Persistentní context (přežije restart Node-RED)
            // 3. Home Assistant entita (záloha)
            // 4. Výchozí false (bezpečné - topení zakázáno dokud termostat nepotvrdí)
            let heatingNeededValue;
            let heatingStates = context.get('heatingStates') || {};

            if (t === devConfig.heatingNeeded || t === TOPIC_HEATING_NEEDED) {
                // Zpráva přišla přímo od termostatu
                heatingNeededValue = msg.payload;
                // Uložit do persistentního context
                heatingStates[devConfig.heatingNeeded] = heatingNeededValue;
                context.set('heatingStates', heatingStates);
            } else {
                // Zkusit načíst z persistentního context
                heatingNeededValue = heatingStates[devConfig.heatingNeeded];

                // Pokud není v context, zkusit Home Assistant entitu jako zálohu
                if (heatingNeededValue === undefined) {
                    let haEntity = "input_boolean." + devConfig.heatingNeeded;
                    let haState = safeState(haEntity, undefined);
                    if (haState !== undefined) {
                        heatingNeededValue = (haState === "on");
                    }
                }

                // Výchozí: zakázáno (bezpečnější - čekat na potvrzení od termostatu)
                if (heatingNeededValue === undefined) {
                    heatingNeededValue = false;
                }
            }

            // Vyhodnotit boolean hodnotu
            let heatingStr = String(heatingNeededValue).toLowerCase();
            canRunHeating = (heatingStr === "true" || heatingStr === "on" || heatingStr === "1");
        }

        if (devConfig.isEV && !canRunEV) {
            if (hasPermission) {
                permissionMessages.push({ topic: devConfig.permission, payload: "off" });
            }
            continue;
        }

        // Pokud termostat neříká že je potřeba topit, přeskočit zařízení
        if (devConfig.heatingNeeded && !canRunHeating) {
            if (hasPermission) {
                permissionMessages.push({ topic: devConfig.permission, payload: "off" });
            }
            continue;
        }

        // Kontrola manuálního přepínače (manualOverride) - pokud je zapnutý, přeskočit zařízení
        let isManualOverrideActive = false;
        if (devConfig.manualOverride) {
            // Získat aktuální stav manuálního přepínače - priorita:
            // 1. Zpráva od přepínače (msg.payload)
            // 2. Home Assistant entita (primary source of truth)
            // 3. Persistentní context (záloha)
            // 4. Výchozí false (přebytkové řízení povoleno)
            let manualOverrideValue;
            let overrideStates = context.get('overrideStates') || {};

            if (t === devConfig.manualOverride || t === TOPIC_MANUAL_OVERRIDE) {
                // Zpráva přišla přímo od manuálního přepínače
                manualOverrideValue = msg.payload;
                // Uložit do persistentního context
                overrideStates[devConfig.manualOverride] = manualOverrideValue;
                context.set('overrideStates', overrideStates);
            } else {
                // Primárně číst z Home Assistant entity (input_boolean)
                let haEntity = "input_boolean." + devConfig.manualOverride;
                let haState = safeState(haEntity, undefined);
                if (haState !== undefined) {
                    manualOverrideValue = (haState === "on");
                } else {
                    // Záloha: persistentní context
                    manualOverrideValue = overrideStates[devConfig.manualOverride];
                }

                // Výchozí: přebytkové řízení povoleno
                if (manualOverrideValue === undefined) {
                    manualOverrideValue = false;
                }
            }

            // Vyhodnotit boolean hodnotu - pokud je ON, přeskočit zařízení
            let overrideStr = String(manualOverrideValue).toLowerCase();
            isManualOverrideActive = (overrideStr === "true" || overrideStr === "on" || overrideStr === "1");
        }

        // Pokud je manuální přepínač zapnutý, přeskočit zařízení (uživatel ovládá topení manuálně)
        if (isManualOverrideActive) {
            if (hasPermission) {
                permissionMessages.push({ topic: devConfig.permission, payload: "off" });
            }
            continue;
        }

        let requiredWatts = devConfig.isEV ? devConfig.minWatt : devConfig.watt;

        let currentWatts = 0;
        if (isReallyRunning) {
            if (devConfig.isEV && devConfig.evPowerTable) {
                let brightness = safeAttr(devConfig.entity, "brightness", 0);
                if (brightness >= devConfig.minBrightness) {
                    // Najít odpovídající nebo nejbližší hodnotu v lookup tabulce
                    let table = devConfig.evPowerTable;
                    let foundWatts = table[0].watt; // Default: minimum

                    for (let j = 0; j < table.length; j++) {
                        if (brightness >= table[j].brightness) {
                            foundWatts = table[j].watt;
                        }
                    }
                    currentWatts = foundWatts;
                }
            } else if (devConfig.isEV) {
                // Fallback pro starou konfiguraci bez tabulky
                let brightness = safeAttr(devConfig.entity, "brightness", 0);
                if (brightness >= devConfig.minBrightness) {
                    currentWatts = devConfig.minWatt;
                }
            } else {
                currentWatts = devConfig.watt;
            }
        }

        priorityQueue.push({
            priority: i,
            device: devConfig,
            requiredWatts: requiredWatts,
            currentWatts: currentWatts,
            isRunning: isReallyRunning,
            hasPermission: hasPermission
        });
    }
}

let newPermissions = {};
let evPermissionDesired = "off";

// ═══════════════════════════════════════════════════════════════════════════
// OCHRANA BATERIE + STAVOVÝ AUTOMAT — řízení přebytků s prioritou baterie
// ═══════════════════════════════════════════════════════════════════════════
let batteryPower = getBatteryPower();
let batterySoc = getBatterySoc();
let now_ts = Date.now();

// Sledování historie výkonu baterie (max 120s buffer — potřeba pro stabilizaci 90s)
{
    let bpHistory = context.get('batteryPowerHistory') || [];
    bpHistory.push({ power: batteryPower, time: now_ts });
    let cutoff = now_ts - 120000;
    bpHistory = bpHistory.filter(s => s.time >= cutoff);
    context.set('batteryPowerHistory', bpHistory);
}

// 🟡 P_ch_max_est — pasivní odhad max nabíjecího výkonu baterie
let anySurplusDeviceRunning = priorityQueue.some(pq => pq.isRunning);
let pChMaxEst = updatePChMaxEst(batteryPower, anySurplusDeviceRunning, batterySoc);

// 🔵 STAVOVÝ AUTOMAT — určit aktuální stav
let prevFsmState = context.get('fsmState') || STATE_CHARGE_PRIORITY;
let fsmState = updateFsmState(prevFsmState, batteryPower, batterySoc, pChMaxEst, availablePower);
context.set('fsmState', fsmState);

// 🟢 PROBE TEST — aktivní zjišťování kapacity baterie
let probeState = updateProbeState(batteryPower, batterySoc, fsmState, priorityQueue);

// DIAGNOSTIKA — periodický log + okamžitý při změně FSM stavu
{
    let lastDiagLog = context.get('lastDiagLogTime') || 0;
    let lastDiagFsm = context.get('lastDiagFsmState');
    const DIAG_LOG_MS = 30000;
    const diagLine = "stav=" + fsmState +
        " přebytek=" + availablePower.toFixed(0) + "W" +
        " bat=" + batteryPower.toFixed(0) + "W SOC=" + batterySoc + "%";

    if (fsmState !== lastDiagFsm) {
        node.warn("PŘEBYTKY [ZMĚNA]: " + diagLine);
        context.set('lastDiagLogTime', now_ts);
        context.set('lastDiagFsmState', fsmState);
    } else if (now_ts - lastDiagLog >= DIAG_LOG_MS) {
        node.warn("PŘEBYTKY [30s]: " + diagLine);
        context.set('lastDiagLogTime', now_ts);
        context.set('lastDiagFsmState', fsmState);
    }
}
// �🔴 ON/OFF ROLLBACK — kontrola zařízení zapnutých v posledních 15s
let rollbackPerms = checkOnOffRollbacks(batteryPower, currentGrid);

// ═══════════════════════════════════════════════════════════════════════════
// ALOKACE VÝKONU ŘÍZENÁ STAVOVÝM AUTOMATEM
// ═══════════════════════════════════════════════════════════════════════════

// Spočítat celkový dostupný výkon
let totalAvailablePower = availablePower;
for (let pq of priorityQueue) {
    if (pq.isRunning) {
        totalAvailablePower += pq.currentWatts;
    }
}

// Deficit baterie: kolik chybí oproti P_ch_max_est
let batteryDeficit = 0;
if (fsmState === STATE_SURPLUS_CONTROL && batteryPower > BATTERY_IDLE_THRESHOLD && pChMaxEst > 0) {
    batteryDeficit = Math.max(0, pChMaxEst - batteryPower);
}

totalAvailablePower -= batteryDeficit;
if (totalAvailablePower < 0) totalAvailablePower = 0;

// Požadovaná stabilita pro zapnutí nového zařízení
let requiredStabilityMs = getRequiredStabilityMs(batterySoc);
// V FULL_MODE nebo pokud baterie nenabíjí → žádná stabilita
if (fsmState === STATE_FULL_MODE || batteryPower <= BATTERY_IDLE_THRESHOLD) {
    requiredStabilityMs = 0;
}

// FULL_MODE: zjistit akci pro vybíjení
let fullAction = "ok";
if (fsmState === STATE_FULL_MODE) {
    fullAction = getFullModeDischargeAction(batteryPower);
}

// Probe: pokud probíhá probe, dočasně snížit dostupný výkon pro EV
let probeReduction = 0;
if (probeState.active && probeState.reduceAmount > 0) {
    probeReduction = probeState.reduceAmount;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEKVENČNÍ ALOKACE VÝKONU PODLE PRIORIT
// ═══════════════════════════════════════════════════════════════════════════
let remainingPower = totalAvailablePower;
let allPreviousRunning = true;
let onoffTurnedOnThisCycle = [];

for (let pq of priorityQueue) {
    let powerNeededForTurnOn = pq.requiredWatts + ONOFF_HYSTERESIS_ON;
    let powerNeededForStayOn = pq.requiredWatts - ONOFF_HYSTERESIS_OFF;
    // FIX: běžící EV reservuje currentWatts (ne maxWatt) — přesnější účetnictví
    // maxWatt se používá jen pro neběžící EV (rezerva pro rozběh)
    let powerToReserve;
    if (pq.device.isEV && pq.device.maxWatt) {
        powerToReserve = pq.isRunning ? pq.currentWatts : pq.device.maxWatt;
    } else {
        powerToReserve = pq.requiredWatts;
    }

    // Rollback: pokud toto zařízení je v rollback seznamu → vypnout
    if (rollbackPerms.includes(pq.device.permission)) {
        newPermissions[pq.device.permission] = "off";
        allPreviousRunning = false;
        if (pq.device.isEV) evPermissionDesired = "off";
        continue;
    }

    // ══ CHARGE_PRIORITY: vše vypnout ══
    if (fsmState === STATE_CHARGE_PRIORITY) {
        if (pq.isRunning) {
            // Okamžitě vypnout — baterie má přednost
            newPermissions[pq.device.permission] = "off";
        } else {
            newPermissions[pq.device.permission] = "off";
        }
        allPreviousRunning = false;
        if (pq.device.isEV) evPermissionDesired = "off";
        continue;
    }

    // ══ FULL_MODE: stupňované vypínání při vybíjení ══
    if (fsmState === STATE_FULL_MODE && fullAction !== "ok") {
        if (fullAction === "off_all") {
            newPermissions[pq.device.permission] = "off";
            if (pq.device.isEV) evPermissionDesired = "off";
            continue;
        }
        // "off_one" — vypnout nejnižší prioritu (poslední v queue)
        // "reduce_analog" — stáhnout plynulou (řeší se jinde přes EV brightness)
        // Pro "off_one" najdeme nejnižší ON/OFF prioritu a vypneme
    }

    // ══ SURPLUS_CONTROL / FULL_MODE (normální provoz): alokace výkonu ══
    if (pq.isRunning) {
        // Zařízení běží — může zůstat zapnuté?
        if (remainingPower >= powerNeededForStayOn) {
            newPermissions[pq.device.permission] = "on";
            remainingPower -= powerToReserve;
        } else {
            // Nedostatek výkonu → vypnout
            newPermissions[pq.device.permission] = "off";
            context.set('lastOnOffChangeTime', now_ts);
            // Zaznamenat čas vypnutí pro cooldown
            let onoffTs1 = context.get('onoffTimestamps') || {};
            if (!onoffTs1[pq.device.permission]) onoffTs1[pq.device.permission] = { lastOn: 0, lastOff: 0 };
            onoffTs1[pq.device.permission].lastOff = now_ts;
            context.set('onoffTimestamps', onoffTs1);
            allPreviousRunning = false;
        }
    } else {
        // Zařízení neběží — může se zapnout?
        // FIX: oddělené cooldowny — lastOffTs (min-off 120s) + lastOnTs (anti-flap 30s)
        let onoffTimestamps = context.get('onoffTimestamps') || {};
        let ts = onoffTimestamps[pq.device.permission] || { lastOn: 0, lastOff: 0 };
        let cooldownAfterOff = (now_ts - ts.lastOff >= ONOFF_COOLDOWN_OFF_MS);   // 120s min-off
        let cooldownAfterOn = (now_ts - ts.lastOn >= ONOFF_COOLDOWN_ON_MS);      // 30s anti-flap
        let cooldownOk = cooldownAfterOff && cooldownAfterOn;

        // Stabilita nabíjení baterie
        let stabilityOk = (requiredStabilityMs === 0 || isBatteryChargingStable(requiredStabilityMs));

        // FIX: stabilita přebytku — pro ON/OFF zařízení zkontrolovat i grid export
        // FIX: requiredStabilityMs===0 (FULL_MODE) → 10s místo chybných 20s (0||20000)
        let surplusStableDuration = (requiredStabilityMs === 0) ? 10000 : Math.min(requiredStabilityMs, 30000);
        let surplusStableOk = pq.device.isEV ? true :
            isSurplusStable(powerNeededForTurnOn, surplusStableDuration);

        // Probe redukce — pokud probe běží, nepovolovat nové zapnutí
        let probeOk = !probeState.active;

        if (allPreviousRunning && remainingPower >= powerNeededForTurnOn
            && stabilityOk && cooldownOk && probeOk && surplusStableOk
            && fsmState !== STATE_CHARGE_PRIORITY) {
            newPermissions[pq.device.permission] = "on";
            remainingPower -= powerToReserve;
            allPreviousRunning = false; // Čekat na rozběh

            // Zaznamenat čas zapnutí pro cooldown
            let onoffTs2 = context.get('onoffTimestamps') || {};
            if (!onoffTs2[pq.device.permission]) onoffTs2[pq.device.permission] = { lastOn: 0, lastOff: 0 };
            onoffTs2[pq.device.permission].lastOn = now_ts;
            context.set('onoffTimestamps', onoffTs2);

            // Zaregistrovat rollback check pro ON/OFF zařízení (ne EV)
            if (!pq.device.isEV) {
                let rollbacks = context.get('onoffRollbacks') || {};
                rollbacks[pq.device.permission] = {
                    timestamp: now_ts,
                    pBatBefore: batteryPower
                };
                context.set('onoffRollbacks', rollbacks);
                context.set('lastOnOffChangeTime', now_ts);
            }
        } else {
            // FIX: Pokud zařízení UŽ MÁ povolenku a je v cooldown okně po zapnutí,
            // NEODEBÍRAT ji — wallbox/zařízení potřebuje čas na fyzický rozběh.
            // Bez tohoto fixu: povolenka ON → 5s → isRunning=false (wallbox nestartoval) →
            // cooldownOk=false → else → povolenka OFF → wallbox nikdy nenastartuje!
            if (pq.hasPermission && !cooldownAfterOn) {
                // Zařízení bylo právě zapnuto, čekáme na rozběh — zachovat povolenku
                newPermissions[pq.device.permission] = "on";
                remainingPower -= powerToReserve;
            } else {
                newPermissions[pq.device.permission] = "off";
            }
        }
    }

    if (pq.device.isEV) {
        evPermissionDesired = newPermissions[pq.device.permission];
    }
}

// FULL_MODE "off_one": vypnout nejnižší ON/OFF prioritu která běží
if (fsmState === STATE_FULL_MODE && fullAction === "off_one") {
    for (let i = priorityQueue.length - 1; i >= 0; i--) {
        let pq = priorityQueue[i];
        if (pq.isRunning && !pq.device.isEV && newPermissions[pq.device.permission] === "on") {
            newPermissions[pq.device.permission] = "off";
            context.set('lastOnOffChangeTime', now_ts);
            break; // Jen jednu
        }
    }
}

// Probe: pokud probe aktivní, redukovat EV výkon (řeší se přes brightness wallboxu)
// Probe redukci zpracuje wallbox logika automaticky přes snížený remainingPower

// Přepočítat statusMessages - stav priority = zařízení zapnuté AND má povolenku
statusMessages = [];
for (let i = 1; i <= 4; i++) {
    let selectId = ENTITY_IDS.prioritySelect(i);
    let statusTopic = ENTITY_IDS.priorityStatus(i);
    let prioritySwitchId = PRIORITY_SWITCHES[i - 1];

    // Pokud je vypínač priority vypnutý, stav je vždy off
    let isPrioritySwitchOn = getFrozenOrCurrentSwitch(prioritySwitchId, frozenConfig, isServiceModeOn) === "on";
    if (!isPrioritySwitchOn) {
        statusMessages.push({
            topic: statusTopic,
            payload: "off"
        });
        continue;
    }

    let assignedDeviceName = getFrozenOrCurrentSelect(selectId, frozenConfig, isServiceModeOn);
    let devConfig = devices.find(d => d.name === assignedDeviceName);

    let isDeviceOn = getDeviceRunningState(devConfig, t, msg.payload);
    let hasPermission = devConfig ? (safeState(devConfig.permission, "off") === "on") : false;

    // Pro EV speciální podmínky
    if (devConfig && devConfig.isEV) {
        let bat = safeBattery();
        if (isManualChargeOn || bat >= 100) {
            hasPermission = false;
        }
    }

    // Stav priority = zařízení reálně běží
    statusMessages.push({
        topic: statusTopic,
        payload: isDeviceOn ? "on" : "off"
    });
}

for (let device of devices) {
    let desiredState = newPermissions[device.permission];
    if (desiredState !== undefined) {
        let currentState = safeState(device.permission, "off");
        if (currentState !== desiredState) {
            permissionMessages.push({ topic: device.permission, payload: desiredState });
        }
    }
}

let desiredScanInterval = (evPermissionDesired === "on") ? SCAN_FAST : SCAN_SLOW;
let currentScanInterval = parseFloat(safeState(SCAN_INTERVAL_ENTITY, SCAN_SLOW));

if (currentScanInterval !== desiredScanInterval) {
    scanIntervalMessages.push({ topic: "ev_scan_interval", payload: desiredScanInterval });
}

let finalStatusMessages = [];
for (let m of statusMessages) {
    if (m.forceUpdate || lastStates[m.topic] !== m.payload) {
        lastStates[m.topic] = m.payload;
        finalStatusMessages.push({ topic: m.topic, payload: m.payload });
    }
}

let finalPermissionMessages = [];
let permCooldowns = context.get('permCooldowns') || {};
let now = Date.now();

for (let m of permissionMessages) {
    // Kontrola cooldownu - neposílat změnu pokud ještě neuplynul cooldown
    let lastChange = permCooldowns[m.topic] || 0;
    let cooldownRemaining = PERMISSION_COOLDOWN_MS - (now - lastChange);

    if (m.forceUpdate) {
        finalPermissionMessages.push({
            topic: m.topic,
            payload: m.payload
        });
        lastPerms[m.topic] = m.payload;
        permCooldowns[m.topic] = now;
    } else if (lastPerms[m.topic] !== m.payload) {
        // VYPÍNÁNÍ je vždy okamžité (ochrana baterie)
        // ZAPÍNÁNÍ podléhá cooldownu (ochrana proti flappingu)
        let isTurningOff = (m.payload === "off");
        if (isTurningOff || cooldownRemaining <= 0) {
            // Cooldown uplynul, můžeme poslat změnu
            lastPerms[m.topic] = m.payload;
            permCooldowns[m.topic] = now;
            finalPermissionMessages.push({
                topic: m.topic,
                payload: m.payload
            });
        }
        // Pokud cooldown ještě neuplynul, nezměníme stav (počkáme)
    }
}

context.set('permCooldowns', permCooldowns);

let finalScanIntervalMessages = [];
for (let m of scanIntervalMessages) {
    if (m.forceUpdate) {
        finalScanIntervalMessages.push({
            topic: m.topic,
            payload: m.payload
        });
        lastScanInterval = m.payload;
    } else if (lastScanInterval !== m.payload) {
        lastScanInterval = m.payload;
        finalScanIntervalMessages.push({
            topic: m.topic,
            payload: m.payload
        });
    }
}

context.set('lastStates', lastStates);
context.set('lastPerms', lastPerms);
context.set('lastScanInterval', lastScanInterval);

return [finalStatusMessages, finalPermissionMessages, finalScanIntervalMessages];