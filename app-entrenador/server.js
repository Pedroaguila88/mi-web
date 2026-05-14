// ============================================
//  COACH SYSTEM v8.3.0 - DIAGNÓSTICO TOTAL
// ============================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Configuración de PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 2. Middlewares (Aumentamos el límite para fotos pesadas)
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// 3. Verificación de conexión inicial
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ ERROR DE CONEXIÓN A POSTGRES:', err.message);
    } else {
        console.log('✅ CONECTADO A NEON POSTGRESQL');
    }
});

// --- RUTA DE PRUEBA: Escribe tu-url.com/api/test en el navegador ---
app.get('/api/test', async (req, res) => {
    try {
        const result = await pool.query('SELECT current_database(), (SELECT count(*) FROM usuarios) as total_users');
        res.json({ ok: true, database: result.rows[0].current_database, total_usuarios: result.rows[0].total_users });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- RUTA: LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const userClean = usuario.toLowerCase().trim();
        console.log(`🔑 Intento de login: ${userClean}`);

        if (userClean === process.env.MASTER_USER) {
            const match = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (match) return res.json({ ok: true, role: 'dev', usuario: userClean });
        }

        const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [userClean]);
        const cuenta = result.rows[0];

        if (!cuenta) return res.status(401).json({ ok: false, msg: 'No existe el usuario' });

        const passMatch = await bcrypt.compare(password, cuenta.pass_hash);
        if (!passMatch) return res.status(401).json({ ok: false, msg: 'Password mal' });

        res.json({ ok: true, role: cuenta.role, usuario: userClean, profe_asignado: cuenta.profe_asignado });
    } catch (e) {
        console.error('Error Login:', e.message);
        res.status(500).send('Error');
    }
});

// --- RUTA: OBTENER TODO (Dashboard) ---
app.get('/api/datos', async (req, res) => {
    try {
        const usersRes = await pool.query('SELECT * FROM usuarios');
        const rutinasRes = await pool.query('SELECT * FROM rutinas');
        
        const usersObj = {};
        usersRes.rows.forEach(u => { usersObj[u.usuario] = u; });

        const rutinasObj = {};
        rutinasRes.rows.forEach(r => { rutinasObj[r.usuario] = r.data_json; });

        console.log(`📊 Datos enviados: ${usersRes.rowCount} usuarios, ${rutinasRes.rowCount} rutinas`);
        res.json({ users: usersObj, rutinas: rutinasObj, biblioteca: [] });
    } catch (e) {
        console.error('Error Datos:', e.message);
        res.status(500).json({ ok: false });
    }
});

// --- RUTA: CREAR / ACTUALIZAR USUARIO (Incluye FOTO) ---
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, fechaInicio, foto } = req.body;
        console.log(`👤 Creando/Actualizando: ${usuario} (Foto: ${foto ? 'SÍ' : 'NO'})`);
        
        const hash = await bcrypt.hash(password || '123456', 10);
        const userClean = usuario.toLowerCase().trim();

        const query = `
            INSERT INTO usuarios (usuario, pass_hash, role, profe_asignado, fecha_inicio, foto) 
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (usuario) 
            DO UPDATE SET 
                role = EXCLUDED.role, 
                profe_asignado = EXCLUDED.profe_asignado,
                foto = COALESCE(EXCLUDED.foto, usuarios.foto),
                fecha_inicio = COALESCE(EXCLUDED.fecha_inicio, usuarios.fecha_inicio)`;
        
        await pool.query(query, [userClean, hash, role, profe_asignado, fechaInicio || null, foto || null]);
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error Usuarios:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- RUTA: GUARDAR RUTINAS (Muy flexible) ---
app.put('/api/rutinas', async (req, res) => {
    try {
        const { usuario, ejercicios, rutina, data } = req.body;
        const contenido = ejercicios || rutina || data;
        const userClean = usuario.toLowerCase().trim();

        console.log(`📝 Guardando rutina para: ${userClean}`);

        if (!contenido) throw new Error("La rutina llegó vacía");

        await pool.query(
            `INSERT INTO rutinas (usuario, data_json) VALUES ($1, $2) 
             ON CONFLICT (usuario) DO UPDATE SET data_json = $2`,
            [userClean, JSON.stringify(contenido)]
        );
        
        console.log("✅ Rutina guardada");
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Error Rutinas:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- RUTA: IA ---
app.post('/api/generar-rutina', async (req, res) => {
    try {
        const { nivel, musculos, notasUsuario, ejerciciosDisponibles } = req.body;
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
        res.status(500).json({ ok: false });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR v8.3.0 ACTIVO EN PUERTO ${PORT}`);
});