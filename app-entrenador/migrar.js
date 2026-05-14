const { Pool } = require('pg');
const fetch = require('node-fetch');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function migrar() {
    try {
        console.log("Reading data from JSONBin...");
        const res = await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': process.env.JSONBIN_API_KEY }
        });
        
        const fullData = await res.json();
        // Intentamos obtener los datos de 'record' o directamente del body
        const data = fullData.record || fullData;

        if (!data || !data.users) {
            console.error("❌ No se encontraron usuarios en JSONBin. Estructura recibida:", fullData);
            return;
        }

        // 1. Migrar Usuarios
        console.log("Migrating users...");
        for (const [user, info] of Object.entries(data.users)) {
            console.log(` > Migrando usuario: ${user}`);
            await pool.query(
                `INSERT INTO usuarios (usuario, pass_hash, role, profe_asignado, foto, fecha_inicio, bloqueado) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) 
                 ON CONFLICT (usuario) DO NOTHING`,
                [user.toLowerCase(), info.passHash, info.role, info.profe_asignado, info.foto, info.fechaInicio, info.bloqueado]
            );
        }

        // 2. Migrar Rutinas
        if (data.rutinas) {
            console.log("Migrating routines...");
            for (const [user, ejercicios] of Object.entries(data.rutinas)) {
                await pool.query(
                    `INSERT INTO rutinas (usuario, data_json) 
                     VALUES ($1, $2) 
                     ON CONFLICT (usuario) DO UPDATE SET data_json = $2`,
                    [user.toLowerCase(), JSON.stringify(ejercicios)]
                );
            }
        }

        console.log("✅ Migration completed successfully!");
    } catch (e) {
        console.error("❌ Error during migration:", e);
    } finally {
        await pool.end();
    }
}

migrar();