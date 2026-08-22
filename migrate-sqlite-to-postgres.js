require('dotenv').config();
const fs = require('fs');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');
if (!fs.existsSync('./database.sqlite')) throw new Error('database.sqlite не найден');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = (sql, p=[]) => pool.query(sql.replace(/\?/g, () => '$' + (p._i = (p._i || 0) + 1)), p);

async function main(){
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database(fs.readFileSync('./database.sqlite'));
  const pg = pool;

  const schema = fs.readFileSync('./schema.sql','utf8');
  await pg.query(schema);

  const tables = {
    users: ['id','username','email','password','avatar','is_temp','created_at','last_seen','is_online','is_typing','typing_to'],
    files: ['id','user_id','original_name','filename','file_type','file_size','upload_date'],
    friends: ['id','from_user','to_user','status','created_at'],
    messages: ['id','sender_id','receiver_id','message_text','file_name','file_type','file_path','file_size','duration_seconds','media_kind','is_read','deleted_for_sender','deleted_for_receiver','forward_from','forward_from_name','is_self_destruct','destruct_after_view','reply_to','reply_text','reply_sender','created_at'],
    avatars: ['id','user_id','avatar_path','is_active','created_at'],
    shared_pins: ['id','message_id','chat_user1','chat_user2','pinned_by','created_at'],
    private_pins: ['id','message_id','chat_user1','chat_user2','pinned_by','created_at'],
    reactions: ['id','message_id','user_id','reaction','created_at'],
    file_access: ['user_id','granted_by','granted_at']
  };

  for (const [table, cols] of Object.entries(tables)) {
    const exists = sqlite.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
    if (!exists.length || !exists[0].values.length) continue;

    const actualCols = sqlite.exec(`PRAGMA table_info(${table})`)[0]?.values?.map(r=>r[1]) || [];
    const useCols = cols.filter(c=>actualCols.includes(c));
    if (!useCols.length) continue;

    const rows = sqlite.exec(`SELECT ${useCols.join(',')} FROM ${table}`)[0];
    if (!rows) continue;

    await pg.query('BEGIN');
    try {
      for (const values of rows.values) {
        const placeholders = values.map((_,i)=>'$'+(i+1)).join(',');
        await pg.query(`INSERT INTO ${table} (${useCols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
      }
      await pg.query('COMMIT');
      console.log(`✅ ${table}: ${rows.values.length}`);
    } catch(e) {
      await pg.query('ROLLBACK');
      throw e;
    }
  }

  for (const table of ['users','friends','messages','avatars','shared_pins','private_pins','reactions']) {
    const idCol = 'id';
    try { await pg.query(`SELECT setval(pg_get_serial_sequence('${table}','${idCol}'), COALESCE((SELECT MAX(id) FROM ${table}),0)+1, false)`); } catch(e) {}
  }
  console.log('🎉 Миграция завершена');
  await pool.end();
}
main().catch(async e=>{ console.error(e); await pool.end(); process.exit(1); });
