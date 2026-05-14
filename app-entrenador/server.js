// ============================================
//  COACH SYSTEM v8.1.0 - Backend PostgreSQL
// ============================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Configuración de la conexión a PostgreSQL (Neon)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 2. Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Verificar conexión con la base de datos al arrancar
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Error crítico: No se pudo conectar a PostgreSQL:', err.message);
    } else {
        console.log('✅ Coach System conectado exitosamente a PostgreSQL');
    }
});

// --- RUTA: LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const userClean = usuario.toLowerCase().trim();

        // Verificación de Usuario Maestro (Dev)
        if (userClean === process.env.MASTER_USER) {
            const match = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (match) return res.json({ ok: true, role: 'dev', usuario: userClean });
            return res.status(401).json({ ok: false, msg: 'Contraseña maestra incorrecta' });
        }

        // Búsqueda de usuario en la base de datos
        const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [userClean]);
        const cuenta = result.rows[0];

        if (!cuenta) return res.status(401).json({ ok: false, msg: 'Usuario no encontrado' });

        const passMatch = await bcrypt.compare(password, cuenta.pass_hash);
        if (!passMatch) return res.status(401).json({ ok: false, msg: 'Contraseña incorrecta' });
        
        if (cuenta.bloqueado) return res.status(401).json({ ok: false, msg: 'Cuenta bloqueada' });

        res.json({ 
            ok: true, 
            role: cuenta.role, 
            usuario: userClean, 
            profe_asignado: cuenta.profe_asignado 
        });
    } catch (e) {
        console.error('Error en login:', e.message);
        res.status(500).json({ ok: false, msg: 'Error interno en el servidor' });
    }
});

// --- RUTA: OBTENER DATOS (Dashboard) ---
app.get('/api/datos', async (req, res) => {
    try {
        const usersRes = await pool.query('SELECT * FROM usuarios');
        const rutinasRes = await pool.query('SELECT * FROM rutinas');
        const bibliotecaRes = await pool.query('SELECT * FROM biblioteca');
        
        // Formatear para compatibilidad con el frontend
        const usersObj = {};
        usersRes.rows.forEach(u => { usersObj[u.usuario] = u; });

        const rutinasObj = {};
        rutinasRes.rows.forEach(r => { rutinasObj[r.usuario] = r.data_json; });

        res.json({
            users: usersObj,
            rutinas: rutinasObj,
            biblioteca: bibliotecaRes.rows,
            mensajeMaster: 'Datos cargados desde PostgreSQL'
        });
    } catch (e) {
        console.error('Error al obtener datos:', e.message);
        res.status(500).json({ ok: false, msg: 'Error al leer la base de datos' });
    }
});

// --- RUTA: CREAR USUARIO ---
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, fechaInicio, foto } = req.body;
        const hash = await bcrypt.hash(password, 10);
        
        const query = `
            INSERT INTO usuarios (usuario, pass_hash, role, profe_asignado, fecha_inicio, foto) 
            VALUES ($1, $2, $3, $4, $5, $6)`;
        
        await pool.query(query, [
            usuario.toLowerCase().trim(), 
            hash, 
            role, 
            profe_asignado, 
            fechaInicio || null, 
            foto || null
        ]);
        
        console.log(`👤 Nuevo usuario creado: ${usuario}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('Error al crear usuario:', e.message);
        res.status(500).json({ ok: false, msg: 'Error: El usuario ya existe o faltan columnas' });
    }
});

// --- RUTA: GUARDAR/ACTUALIZAR RUTINA ---
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
        console.error('Error al guardar rutina:', e.message);
        res.status(500).json({ ok: false, msg: 'Error al actualizar rutina' });
    }
});

// --- RUTA: REGISTRAR PESO (Historial) ---
app.post('/api/historial', async (req, res) => {
    try {
        const { usuario, ejercicio, peso, reps } = req.body;
        await pool.query(
            'INSERT INTO historial (usuario, ejercicio, peso, reps) VALUES ($1, $2, $3, $4)',
            [usuario.toLowerCase(), ejercicio, peso, reps]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('Error en historial:', e.message);
        res.status(500).json({ ok: false, msg: 'Error al registrar peso' });
    }
});

// --- RUTA: GENERAR RUTINA CON IA ---
app.post('/api/generar-rutina', async (req, res) => {
    try {
        const { nivel, musculos, notasUsuario, ejerciciosDisponibles } = req.body;
        
        const prompt = `Actúa como entrenador experto. Genera una rutina en JSON.
        Nivel: ${nivel}. Músculos: ${musculos}. Notas: ${notasUsuario}.
        Ejercicios permitidos: ${ejerciciosDisponibles.join(', ')}.
        Responde SOLO el JSON: [{"nombre":"X","series":3,"reps":"12","instrucciones":"..."}]`;

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
        const rutina = JSON.parse(data.content[0].text.trim());
        res.json({ ok: true, rutina });
    } catch (e) {
        console.error('Error con IA:', e.message);
        res.status(500).json({ ok: false, msg: 'La IA no pudo generar la rutina' });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});