import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL.trim().replace(/\/$/, ''),
  process.env.SUPABASE_SERVICE_KEY.trim()
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. VALIDASI INPUT ──────────────────────────────────
    const {
      chapter_id,
      difficulty = 'sedang',
      incl_materi = true,
      incl_pg = true,
      incl_isian = true,
      incl_essay = true,
      jumlah_pg = 5,
      jumlah_isian = 5,
      jumlah_essay = 3
    } = req.body;

    if (!chapter_id) return res.status(400).json({ error: 'chapter_id required' });

    const validDiff = ['mudah','sedang','sulit'].includes(difficulty) ? difficulty : 'sedang';
    const nPG    = Math.min(Math.max(parseInt(jumlah_pg)    || 5, 1), 20);
    const nIsian = Math.min(Math.max(parseInt(jumlah_isian) || 5, 1), 20);
    const nEssay = Math.min(Math.max(parseInt(jumlah_essay) || 3, 1), 10);

    // ── 2. CEK CACHE ───────────────────────────────────────
    const { data: cached } = await supabase
      .from('generated_cache')
      .select('*')
      .eq('chapter_id', chapter_id)
      .eq('difficulty', validDiff)
      .eq('jumlah_pg', nPG)
      .eq('jumlah_isian', nIsian)
      .eq('jumlah_essay', nEssay)
      .single();

    if (cached) {
      return res.status(200).json({
        success: true,
        data: {
          source: 'cache',
          chapter_id,
          difficulty: validDiff,
          materi:      cached.result_materi,
          pg:          cached.result_pg,
          isian:       cached.result_isian,
          essay:       cached.result_essay,
          kunci_pg:    cached.result_kunci_pg,
          kunci_isian: cached.result_kunci_isian,
          kunci_essay: cached.result_kunci_essay
        }
      });
    }

    // ── 3. AMBIL DATA BAB ──────────────────────────────────
    const { data: chapter, error: chapError } = await supabase
      .from('chapters')
      .select(`
        id, chapter_number, title, subtopics,
        subjects ( name, code, levels ( label, age_desc ) )
      `)
      .eq('id', chapter_id)
      .single();

    if (chapError || !chapter) throw new Error('Chapter tidak ditemukan');

    const subject   = chapter.subjects;
    const level     = subject.levels;
    const subtopics = Array.isArray(chapter.subtopics)
      ? chapter.subtopics.join(', ')
      : chapter.subtopics;

    // ── 4. BUILD PROMPT ────────────────────────────────────
    const diffMap = {
      mudah:  'MUDAH — C1-C2 Bloom (mengingat & memahami). Bahasa sangat sederhana, satu konsep per soal.',
      sedang: 'SEDANG — C2-C3 Bloom (memahami & menerapkan). Kontekstual, sedikit analisis.',
      sulit:  'SULIT — C3-C4 Bloom (menerapkan & menganalisis). Multi-konsep, butuh penalaran.'
    };

    let prompt = `Kamu adalah guru ${level.label} berpengalaman di Indonesia. Buat konten pembelajaran lengkap untuk:

Mata Pelajaran: ${subject.name}
Bab ${chapter.chapter_number}: ${chapter.title}
Sub-topik: ${subtopics}
Untuk: ${level.age_desc}
Tingkat Kesulitan: ${diffMap[validDiff]}

ATURAN WAJIB:
- Bahasa Indonesia yang tepat sesuai jenjang ${level.label}
- Konten sesuai Kurikulum Merdeka Indonesia
- Soal TIDAK mengandung jawaban
- Kunci jawaban HANYA di bagian === KUNCI JAWABAN ===
- Ikuti format persis seperti di bawah\n\n`;

    if (incl_materi) {
      prompt += `=== MATERI PEMBELAJARAN ===
1. Tujuan Pembelajaran (2-3 poin spesifik)
2. Konsep Utama (sesuai usia, pakai analogi jika perlu)
3. Contoh Konkret (dari kehidupan sehari-hari)
4. Aktivitas Kelas (2-3 aktivitas praktis)\n\n`;
    }

    if (incl_pg) {
      prompt += `=== SOAL PILIHAN GANDA ===
Buat ${nPG} soal tingkat ${validDiff}. Format SETIAP soal:
1. [pertanyaan]
   A. [pilihan]
   B. [pilihan]
   C. [pilihan]
   D. [pilihan]\n\n`;
    }

    if (incl_isian) {
      prompt += `=== SOAL ISIAN ===
Buat ${nIsian} soal tingkat ${validDiff}. Format:
1. [kalimat dengan _____ untuk diisi]\n\n`;
    }

    if (incl_essay) {
      prompt += `=== SOAL ESSAY ===
Buat ${nEssay} soal tingkat ${validDiff}. Format:
1. [pertanyaan essay]\n\n`;
    }

    prompt += `=== KUNCI JAWABAN ===\n`;
    if (incl_pg)    prompt += `KUNCI PILIHAN GANDA:\n1. [huruf]: [penjelasan singkat]\n(lanjutkan semua)\n\n`;
    if (incl_isian) prompt += `KUNCI ISIAN:\n1. [jawaban]\n(lanjutkan semua)\n\n`;
    if (incl_essay) prompt += `PANDUAN ESSAY:\n1. [poin-poin jawaban yang diharapkan]\n(lanjutkan semua)\n`;

    // ── 5. PANGGIL GEMINI API ──────────────────────────────
    const geminiKey = process.env.GEMINI_API_KEY.trim();
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4000
        }
      })
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json();
      throw new Error(`Gemini error: ${errData.error?.message || geminiRes.status}`);
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Gemini tidak mengembalikan teks');

    // ── 6. PARSE RESPONSE ──────────────────────────────────
    function extract(text, startMarker, endMarkers) {
      const si = text.indexOf(startMarker);
      if (si === -1) return null;
      let ei = text.length;
      for (const m of endMarkers) {
        const idx = text.indexOf(m, si + startMarker.length + 5);
        if (idx !== -1 && idx < ei) ei = idx;
      }
      return text.substring(si + startMarker.length, ei).replace(/^[=:\-\s]+/, '').trim() || null;
    }

    const secKunci = extract(rawText, 'KUNCI JAWABAN', []);
    const parsed = {
      materi:      extract(rawText, 'MATERI PEMBELAJARAN', ['SOAL PILIHAN','SOAL ISIAN','SOAL ESSAY','KUNCI']),
      pg:          extract(rawText, 'SOAL PILIHAN GANDA',  ['SOAL ISIAN','SOAL ESSAY','KUNCI']),
      isian:       extract(rawText, 'SOAL ISIAN',          ['SOAL ESSAY','KUNCI']),
      essay:       extract(rawText, 'SOAL ESSAY',          ['KUNCI']),
      kunci_pg:    secKunci ? extract(secKunci, 'KUNCI PILIHAN GANDA', ['KUNCI ISIAN','PANDUAN ESSAY']) : null,
      kunci_isian: secKunci ? extract(secKunci, 'KUNCI ISIAN',         ['PANDUAN ESSAY'])               : null,
      kunci_essay: secKunci ? extract(secKunci, 'PANDUAN ESSAY',       [])                              : null,
    };

    // ── 7. SIMPAN KE CACHE ─────────────────────────────────
    await supabase.from('generated_cache').upsert({
      chapter_id,
      difficulty: validDiff,
      incl_materi, incl_pg, incl_isian, incl_essay,
      jumlah_pg: nPG, jumlah_isian: nIsian, jumlah_essay: nEssay,
      result_materi:    parsed.materi,
      result_pg:        parsed.pg,
      result_isian:     parsed.isian,
      result_essay:     parsed.essay,
      result_kunci_pg:    parsed.kunci_pg,
      result_kunci_isian: parsed.kunci_isian,
      result_kunci_essay: parsed.kunci_essay
    }, {
      onConflict: 'chapter_id,difficulty,jumlah_pg,jumlah_isian,jumlah_essay'
    });

    // ── 8. RETURN ──────────────────────────────────────────
    return res.status(200).json({
      success: true,
      data: { source: 'generated', chapter_id, difficulty: validDiff, ...parsed }
    });

  } catch (error) {
    console.error('Generate error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
