import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Ambil semua levels
    const { data: levels, error: levelsError } = await supabase
      .from('levels')
      .select('*')
      .order('sort_order');

    if (levelsError) throw levelsError;

    // Ambil semua subjects
    const { data: subjects, error: subjError } = await supabase
      .from('subjects')
      .select('*')
      .order('sort_order');

    if (subjError) throw subjError;

    // Ambil semua chapters
    const { data: chapters, error: chapError } = await supabase
      .from('chapters')
      .select('id, subject_id, chapter_number, title')
      .order('chapter_number');

    if (chapError) throw chapError;

    // Susun struktur: level → subjects → chapters
    const curriculum = levels.map(level => {
      const levelSubjects = subjects
        .filter(s => s.level_id === level.id)
        .map(subj => ({
          id: subj.id,
          code: subj.code,
          name: subj.name,
          icon: subj.icon,
          color: subj.color,
          chapters: chapters
            .filter(c => c.subject_id === subj.id)
            .map(c => ({
              id: c.id,
              number: c.chapter_number,
              title: c.title
            }))
        }));

      return {
        id: level.id,
        label: level.label,
        icon: level.icon,
        color: level.color,
        sub: level.age_desc,
        subjects: levelSubjects
      };
    });

    return res.status(200).json({ success: true, data: curriculum });

  } catch (error) {
    console.error('Curriculum error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
