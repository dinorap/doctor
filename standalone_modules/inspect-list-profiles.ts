import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '../data/profiles.db'));

console.log('Tables:', db.pragma('table_list').map(t => t.name));

const profiles = db.prepare('SELECT * FROM profiles').all();
console.log('\nProfiles:', profiles.length);
for (const p of profiles) {
    console.log(' ', JSON.stringify(p));
}

const sessions = db.prepare('SELECT * FROM sessions').all();
console.log('\nSessions:', sessions.length);
for (const s of sessions) {
    console.log(' ', JSON.stringify(s));
}

db.close();
