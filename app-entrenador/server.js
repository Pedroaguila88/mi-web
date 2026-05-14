// ============================================
//  COACH SYSTEM v8.0.0 - Backend PostgreSQL
// ============================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la conexión a Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Verificar conexión inicial
pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ Error de conexión a Postgres:', err);
    else console.log('✅ Coach System conectado a PostgreSQL');
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const u = usuario.toLowerCase().trim();

        // 1. Verificar Usuario Maestro (Dev)
        if (u === process.env.MASTER_USER) {
            const ok = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (ok) return res.json({ ok: true, role: 'dev', usuario: u });
            return res.status(401).json({ ok: false, msg: 'Acceso denegado' });
        }

        // 2. Buscar usuario en la base de datos
        const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [u]);
        const cuenta = result.rows[0];

        if (!cuenta) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });

        const match = await bcrypt.compare(password, cuenta.pass_hash);
        if (!match) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });
        if (cuenta.bloqueado) return res.status(401).json({ ok: false, msg: 'Acceso bloqueado. Contactá a tu coach.' });

        // Control de vencimiento de cuota
        if (cuenta.fecha_inicio) {
            const vence = new Date(cuenta.fecha_inicio);
            vence.setMonth(vence.getMonth() + 1);
            if (new Date() >= vence) return res.status(401).json({ ok: false, msg: 'Cuota vencida. Contactá a tu coach.' });
        }

        res.json({ ok: true, role: cuenta.role, usuario: u, profe_asignado: cuenta.profe_asignado });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, msg: 'Error interno' });
    }
});

// --- OBTENER TODOS LOS DATOS (Para el Dashboard) ---
app.get('/api/datos', async (req, res) => {
    try {
        const usersRes = await pool.query('SELECT usuario, role, profe_asignado, foto, fecha_inicio, bloqueado FROM usuarios');
        const rutinasRes = await pool.query('SELECT * FROM rutinas');
        const bibliotecaRes = await pool.query('SELECT * FROM biblioteca');
        
        // Formatear la salida para que sea compatible con tu frontend anterior
        const usersObj = {};
        usersRes.rows.forEach(u => { usersObj[u.usuario] = u; });

        const rutinasObj = {};
        rutinasRes.rows.forEach(r => { rutinasObj[r.usuario] = r.data_json; });

        res.json({
            users: usersObj,
            rutinas: rutinasObj,
            biblioteca: bibliotecaRes.rows,
            historial: {}, // Se puede cargar por demanda para no saturar
            mensajeMaster: 'Sistema Activo en PostgreSQL'
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, msg: 'Error al leer base de datos' });
    }
});

// --- GUARDAR O ACTUALIZAR RUTINA ---
app.put('/api/rutinas', async (req, res) => {
    try {
        const { usuario, ejercicios } = req.body;
        const query = `
            INSERT INTO rutinas (usuario, data_json) 
            VALUES ($1, $2) 
            ON CONFLICT (usuario) 
            DO UPDATE SET data_json = $2`;
        await pool.query(query, [usuario.toLowerCase(), JSON.stringify(ejercicios)]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al guardar rutina' });
    }
});

// --- REGISTRAR EN HISTORIAL (NUEVO: Para evitar colapsos) ---
app.post('/api/historial', async (req, res) => {
    try {
        const { usuario, ejercicio, peso, reps } = req.body;
        await pool.query(
            'INSERT INTO historial (usuario, ejercicio, peso, reps) VALUES ($1, $2, $3, $4)',
            [usuario.toLowerCase(), ejercicio, peso, reps]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al registrar peso' });
    }
});

// --- GENERAR RUTINA IA ---
app.post('/api/generar-rutina', async (req, res) => {
    try {
        const { nivel, musculos, notasUsuario, ejerciciosDisponibles } = req.body;
        const prompt = `Sos un entrenador personal experto. Generá una rutina de gimnasio.
        Nivel: ${nivel} | Músculos: ${musculos}
        Indicaciones: ${notasUsuario || 'Ninguna'}
        Ejercicios: ${ejerciciosDisponibles.join(', ')}
        Devolvé SOLO JSON válido: [{"nombre":"ejercicio","series":4,"reps":"12","instrucciones":"..."}]`;

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
        const texto = data.content[0].text;
        const rutina = JSON.parse(texto.trim());
        res.json({ ok: true, rutina });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error en IA' });
    }
});

// --- GESTIÓN DE USUARIOS ---
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, fechaInicio } = req.body;
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO usuarios (usuario, pass_hash, role, profe_asignado, fecha_inicio) VALUES ($1, $2, $3, $4, $5)',
            [usuario.toLowerCase().trim(), hash, role, profe_asignado, fechaInicio]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al crear usuario' });
    }
});

app.listen(PORT, () => console.log(`🚀 Coach System v8.0.0 corriendo en puerto ${PORT}`));