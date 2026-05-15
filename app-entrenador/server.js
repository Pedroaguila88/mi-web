// ============================================
//  COACH SYSTEM v9.0.0 - NEON POSTGRES COMPLETO
// ============================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Conexión Postgres
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 2. Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// 3. Inicialización: crear tablas que falten
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                usuario        TEXT PRIMARY KEY,
                pass_hash      TEXT NOT NULL,
                role           TEXT,
                profe_asignado TEXT,
                foto           TEXT,
                fecha_inicio   TEXT,
                bloqueado      BOOLEAN DEFAULT FALSE
            );
            CREATE TABLE IF NOT EXISTS rutinas (
                usuario   TEXT PRIMARY KEY,
                data_json JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS historial (
                usuario   TEXT PRIMARY KEY,
                data_json JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recordes (
                usuario   TEXT PRIMARY KEY,
                data_json JSONB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS biblioteca (
                id          TEXT PRIMARY KEY,
                nombre      TEXT NOT NULL,
                objetivo    TEXT,
                descripcion TEXT,
                ejercicios  JSONB NOT NULL DEFAULT '[]'::jsonb,
                creada_en   TEXT
            );
            CREATE TABLE IF NOT EXISTS app_config (
                clave TEXT PRIMARY KEY,
                valor JSONB
            );
        `);
        // Asegurar columna 'bloqueado' por si la tabla ya existía sin ella
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT FALSE`);
        console.log('✅ Tablas verificadas/creadas en Neon');
    } catch (e) {
        console.error('❌ Error creando tablas:', e.message);
    }
}

pool.query('SELECT NOW()', (err) => {
    if (err) console.error('❌ ERROR CONEXIÓN POSTGRES:', err.message);
    else { console.log('✅ CONECTADO A NEON POSTGRESQL'); initDB(); }
});

// ─── Helpers ───────────────────────────────────
function userClean(u) { return (u || '').toString().toLowerCase().trim(); }

// Limpia la fila de usuarios para que el frontend no vea pass_hash
// y reciba fechaInicio (camelCase) como espera.
function mapUserRow(row) {
    if (!row) return null;
    return {
        usuario:        row.usuario,
        role:           row.role,
        profe_asignado: row.profe_asignado,
        foto:           row.foto,
        fechaInicio:    row.fecha_inicio,
        fecha_inicio:   row.fecha_inicio,
        bloqueado:      row.bloqueado
    };
}

// ─── Diagnóstico ───────────────────────────────
app.get('/api/test', async (req, res) => {
    try {
        const r = await pool.query('SELECT current_database(), (SELECT count(*) FROM usuarios) AS total_users');
        res.json({ ok: true, database: r.rows[0].current_database, total_usuarios: r.rows[0].total_users });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── LOGIN ─────────────────────────────────────
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const u = userClean(usuario);
        console.log(`🔑 Login: ${u}`);

        if (u === userClean(process.env.MASTER_USER)) {
            const match = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (match) return res.json({ ok: true, role: 'dev', usuario: u });
        }

        const r = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [u]);
        const cuenta = r.rows[0];
        if (!cuenta) return res.status(401).json({ ok: false, msg: 'No existe el usuario' });
        if (cuenta.bloqueado) return res.status(403).json({ ok: false, msg: 'Usuario bloqueado' });

        const passMatch = await bcrypt.compare(password, cuenta.pass_hash);
        if (!passMatch) return res.status(401).json({ ok: false, msg: 'Password mal' });

        res.json({
            ok: true,
            role: cuenta.role,
            usuario: u,
            profe_asignado: cuenta.profe_asignado
        });
    } catch (e) {
        console.error('Error Login:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── GET TODOS LOS DATOS ───────────────────────
app.get('/api/datos', async (req, res) => {
    try {
        const [usersR, rutinasR, historialR, recordesR, bibR, configR] = await Promise.all([
            pool.query('SELECT usuario, role, profe_asignado, foto, fecha_inicio, bloqueado FROM usuarios'),
            pool.query('SELECT usuario, data_json FROM rutinas'),
            pool.query('SELECT usuario, data_json FROM historial'),
            pool.query('SELECT usuario, data_json FROM recordes'),
            pool.query('SELECT * FROM biblioteca ORDER BY creada_en DESC NULLS LAST'),
            pool.query(`SELECT clave, valor FROM app_config WHERE clave IN ('mensajeMaster','archivos')`)
        ]);

        const users = {};
        usersR.rows.forEach(u => { users[u.usuario] = mapUserRow(u); });

        const rutinas = {};
        rutinasR.rows.forEach(r => { rutinas[r.usuario] = r.data_json; });

        const historial = {};
        historialR.rows.forEach(r => { historial[r.usuario] = r.data_json; });

        const recordes = {};
        recordesR.rows.forEach(r => { recordes[r.usuario] = r.data_json; });

        const biblioteca = bibR.rows.map(r => ({
            id:          r.id,
            nombre:      r.nombre,
            objetivo:    r.objetivo,
            descripcion: r.descripcion,
            ejercicios:  r.ejercicios,
            creadaEn:    r.creada_en
        }));

        const cfg = {};
        configR.rows.forEach(r => { cfg[r.clave] = r.valor; });

        console.log(`📊 GET /api/datos → ${usersR.rowCount} users, ${rutinasR.rowCount} rutinas, ${bibR.rowCount} biblioteca`);
        res.json({
            users,
            rutinas,
            historial,
            recordes,
            biblioteca,
            mensajeMaster: cfg.mensajeMaster || '',
            archivos:      cfg.archivos || { fotos: [], gifs: [] }
        });
    } catch (e) {
        console.error('❌ Error GET /api/datos:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── PUT TODOS LOS DATOS (sincronización masiva) ─
// El frontend llama acá tras cualquier cambio en rutinas/historial/recordes/archivos/mensajeMaster.
app.put('/api/datos', async (req, res) => {
    const client = await pool.connect();
    try {
        const { rutinas, historial, mensajeMaster, recordes, archivos } = req.body;
        await client.query('BEGIN');

        if (rutinas && typeof rutinas === 'object') {
            for (const [u, data] of Object.entries(rutinas)) {
                await client.query(
                    `INSERT INTO rutinas (usuario, data_json) VALUES ($1, $2)
                     ON CONFLICT (usuario) DO UPDATE SET data_json = EXCLUDED.data_json`,
                    [userClean(u), JSON.stringify(data)]
                );
            }
        }
        if (historial && typeof historial === 'object') {
            for (const [u, data] of Object.entries(historial)) {
                await client.query(
                    `INSERT INTO historial (usuario, data_json) VALUES ($1, $2)
                     ON CONFLICT (usuario) DO UPDATE SET data_json = EXCLUDED.data_json`,
                    [userClean(u), JSON.stringify(data)]
                );
            }
        }
        if (recordes && typeof recordes === 'object') {
            for (const [u, data] of Object.entries(recordes)) {
                await client.query(
                    `INSERT INTO recordes (usuario, data_json) VALUES ($1, $2)
                     ON CONFLICT (usuario) DO UPDATE SET data_json = EXCLUDED.data_json`,
                    [userClean(u), JSON.stringify(data)]
                );
            }
        }
        if (mensajeMaster !== undefined) {
            await client.query(
                `INSERT INTO app_config (clave, valor) VALUES ('mensajeMaster', $1)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
                [JSON.stringify(mensajeMaster)]
            );
        }
        if (archivos !== undefined) {
            await client.query(
                `INSERT INTO app_config (clave, valor) VALUES ('archivos', $1)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
                [JSON.stringify(archivos)]
            );
        }

        await client.query('COMMIT');
        console.log('✅ PUT /api/datos guardado');
        res.json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Error PUT /api/datos:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// ─── CREAR USUARIO ─────────────────────────────
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, fechaInicio, foto, bloqueado } = req.body;
        const u = userClean(usuario);
        console.log(`👤 Crear: ${u} (Foto: ${foto ? 'SÍ' : 'NO'})`);
        const hash = await bcrypt.hash(password || '123456', 10);

        await pool.query(`
            INSERT INTO usuarios (usuario, pass_hash, role, profe_asignado, fecha_inicio, foto, bloqueado)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (usuario) DO UPDATE SET
                role           = EXCLUDED.role,
                profe_asignado = EXCLUDED.profe_asignado,
                foto           = COALESCE(EXCLUDED.foto, usuarios.foto),
                fecha_inicio   = COALESCE(EXCLUDED.fecha_inicio, usuarios.fecha_inicio),
                bloqueado      = COALESCE(EXCLUDED.bloqueado, usuarios.bloqueado)`,
            [u, hash, role, profe_asignado || null, fechaInicio || null, foto || null, bloqueado || false]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error POST /api/usuarios:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── EDITAR USUARIO ────────────────────────────
// Admite: nuevoUsuario, nuevaPassword ('_KEEP_' para no tocar), foto, profe_asignado, fechaInicio, bloqueado, role
app.put('/api/usuarios/:usuario', async (req, res) => {
    const client = await pool.connect();
    try {
        const oldU = userClean(req.params.usuario);
        const { nuevoUsuario, nuevaPassword, foto, profe_asignado, fechaInicio, bloqueado, role } = req.body;
        const newU = nuevoUsuario ? userClean(nuevoUsuario) : oldU;

        console.log(`✏️ PUT /api/usuarios/${oldU} → ${newU}`);

        await client.query('BEGIN');

        // Verificar que el usuario existe
        const exists = await client.query('SELECT usuario FROM usuarios WHERE usuario = $1', [oldU]);
        if (exists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, msg: 'Usuario no existe' });
        }

        // Cambio de nombre: renombrar PK y propagar a tablas dependientes
        if (newU !== oldU) {
            const dup = await client.query('SELECT usuario FROM usuarios WHERE usuario = $1', [newU]);
            if (dup.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ ok: false, msg: 'Ya existe un usuario con ese nombre' });
            }
            await client.query('UPDATE usuarios  SET usuario = $1 WHERE usuario = $2', [newU, oldU]);
            await client.query('UPDATE rutinas   SET usuario = $1 WHERE usuario = $2', [newU, oldU]);
            await client.query('UPDATE historial SET usuario = $1 WHERE usuario = $2', [newU, oldU]);
            await client.query('UPDATE recordes  SET usuario = $1 WHERE usuario = $2', [newU, oldU]);
            await client.query('UPDATE usuarios  SET profe_asignado = $1 WHERE profe_asignado = $2', [newU, oldU]);
        }

        // Updates condicionales
        if (nuevaPassword && nuevaPassword !== '_KEEP_') {
            const hash = await bcrypt.hash(nuevaPassword, 10);
            await client.query('UPDATE usuarios SET pass_hash = $1 WHERE usuario = $2', [hash, newU]);
        }
        if (foto !== undefined) {
            await client.query('UPDATE usuarios SET foto = $1 WHERE usuario = $2', [foto, newU]);
        }
        if (profe_asignado !== undefined) {
            await client.query('UPDATE usuarios SET profe_asignado = $1 WHERE usuario = $2', [profe_asignado, newU]);
        }
        if (fechaInicio !== undefined) {
            await client.query('UPDATE usuarios SET fecha_inicio = $1 WHERE usuario = $2', [fechaInicio, newU]);
        }
        if (bloqueado !== undefined) {
            await client.query('UPDATE usuarios SET bloqueado = $1 WHERE usuario = $2', [bloqueado, newU]);
        }
        if (role !== undefined) {
            await client.query('UPDATE usuarios SET role = $1 WHERE usuario = $2', [role, newU]);
        }

        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Error PUT /api/usuarios:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// ─── BORRAR USUARIO ────────────────────────────
app.delete('/api/usuarios/:usuario', async (req, res) => {
    const client = await pool.connect();
    try {
        const u = userClean(req.params.usuario);
        await client.query('BEGIN');
        await client.query('DELETE FROM rutinas   WHERE usuario = $1', [u]);
        await client.query('DELETE FROM historial WHERE usuario = $1', [u]);
        await client.query('DELETE FROM recordes  WHERE usuario = $1', [u]);
        await client.query('DELETE FROM usuarios  WHERE usuario = $1', [u]);
        await client.query('COMMIT');
        console.log(`🗑️ Usuario eliminado: ${u}`);
        res.json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Error DELETE /api/usuarios:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// ─── RUTINAS (legacy single-user) ──────────────
app.put('/api/rutinas', async (req, res) => {
    try {
        const { usuario, ejercicios, rutina, data } = req.body;
        const contenido = ejercicios || rutina || data;
        const u = userClean(usuario);
        if (!contenido) throw new Error('La rutina llegó vacía');
        await pool.query(
            `INSERT INTO rutinas (usuario, data_json) VALUES ($1, $2)
             ON CONFLICT (usuario) DO UPDATE SET data_json = EXCLUDED.data_json`,
            [u, JSON.stringify(contenido)]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error PUT /api/rutinas:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── BIBLIOTECA ────────────────────────────────
app.post('/api/biblioteca', async (req, res) => {
    try {
        const { nombre, objetivo, descripcion, ejercicios } = req.body;
        const id = Date.now().toString() + Math.random().toString(36).slice(2, 7);
        const creada = new Date().toLocaleDateString('es-PY');
        await pool.query(
            `INSERT INTO biblioteca (id, nombre, objetivo, descripcion, ejercicios, creada_en)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, nombre, objetivo || null, descripcion || null, JSON.stringify(ejercicios || []), creada]
        );
        res.json({ ok: true, id });
    } catch (e) {
        console.error('❌ Error POST /api/biblioteca:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.put('/api/biblioteca/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, objetivo, descripcion, ejercicios } = req.body;
        await pool.query(
            `UPDATE biblioteca
             SET nombre = $1, objetivo = $2, descripcion = $3, ejercicios = $4
             WHERE id = $5`,
            [nombre, objetivo || null, descripcion || null, JSON.stringify(ejercicios || []), id]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error PUT /api/biblioteca:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.delete('/api/biblioteca/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM biblioteca WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error DELETE /api/biblioteca:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── IA ────────────────────────────────────────
app.post('/api/generar-rutina', async (req, res) => {
    try {
        const { nivel, musculos, notasUsuario } = req.body;
        const prompt = `Rutina JSON para ${nivel}, musculos: ${musculos}. Notas: ${notasUsuario}. Solo JSON.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-3-haiku-20240307',
                max_tokens: 1000,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();
        res.json({ ok: true, rutina: JSON.parse(data.content[0].text) });
    } catch (e) {
        console.error('Error IA:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR v9.0.0 ACTIVO EN PUERTO ${PORT}`);
});
