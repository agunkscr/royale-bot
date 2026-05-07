// ═══════════════════════════════════════════════════════════════════
// smoltz-optimizer.js — mengarahkan bot ke sumber sMoltz
// ═══════════════════════════════════════════════════════════════════

/**
 * Cari region terbaik yang mengandung guardian atau item rewards.
 * @param {Array} connections - region terhubung (string atau objek region)
 * @param {Set} dangerIds - region berbahaya yang harus dihindari
 * @param {Object} view - data view lengkap dari server
 * @param {Array} inventory - inventory bot saat ini
 * @returns {string|null} regionId tujuan, atau null jika tidak ada
 */
export function getBestSmoltzRegion(connections, dangerIds, view, inventory) {
    const visibleAgents = view.visibleAgents || [];
    const visibleItems = unwrapItems(view.visibleItems || []);

    // Kumpulkan region yang aman
    const safeRegions = [];
    for (const conn of connections) {
        const rid = typeof conn === 'string' ? conn : conn.id;
        const resolved = typeof conn === 'object' ? conn : resolveRegion(conn, view);
        if (!rid || dangerIds.has(rid) || resolved?.isDeathZone) continue;
        safeRegions.push({ rid, resolved });
    }

    // Skor setiap region berdasarkan potensi sMoltz
    const scored = safeRegions.map(({ rid, resolved }) => {
        let score = 0;

        // 1. Guardian di region itu? (nilai 120 sMoltz per guardian)
        const guardiansThere = visibleAgents.filter(
            a => a.isGuardian && a.isAlive && a.regionId === rid
        );
        score += guardiansThere.length * 100; // guardian sangat berharga

        // 2. Item rewards di region itu? (nilai 100+ sMoltz)
        const rewardsThere = visibleItems.filter(
            i => i.regionId === rid && (i.typeId === 'rewards' || i.category === 'currency')
        );
        score += rewardsThere.length * 80;

        return { rid, score, guardiansThere, rewardsThere };
    });

    // Pilih skor tertinggi (minimal 50 agar tidak sia-sia)
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best && best.score >= 50) {
        return best.rid;
    }

    return null;
}

// ── Helper ─────────────────────────────────────────────────────────
function unwrapItems(raw) {
    const out = [];
    for (const entry of (raw || [])) {
        if (!entry || typeof entry !== 'object') continue;
        const inner = entry.item || entry;
        if (inner && typeof inner === 'object') {
            inner.regionId = entry.regionId || inner.regionId || '';
            out.push(inner);
        }
    }
    return out;
}

function resolveRegion(entry, view) {
    if (typeof entry === 'object') return entry;
    if (typeof entry === 'string')
        return (view.visibleRegions || []).find(r => r.id === entry) || null;
    return null;
}