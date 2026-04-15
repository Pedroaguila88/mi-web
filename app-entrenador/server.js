// ============================================
//  COACH SYSTEM v7.0.0 - Backend Proxy Seguro
//  Instalar dependencias: npm install
//  Correr: node server.js
// ============================================

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcrypt');
const fetch    = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.JSONBIN_API_KEY;
const BIN_ID  = process.env.JSONBIN_BIN_ID;

// -- MIDDLEWARES --
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Helpers JSONBin ──────────────────────────────────────────────
async function leerBin() {
    const res  = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
        headers: { 'X-Master-Key': API_KEY }
    });
    const data = await res.json();
    return data.record || { users: {}, rutinas: {}, historial: {}, mensajeMaster: '', recordes: {}, biblioteca: [] };
}

async function escribirBin(datos) {
    await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
        body:    JSON.stringify(datos)
    });
}

// ── RUTAS ────────────────────────────────────────────────────────

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const u = usuario.toLowerCase().trim();

        if (u === process.env.MASTER_USER) {
            const ok = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (ok) return res.json({ ok: true, role: 'dev', usuario: u });
            return res.status(401).json({ ok: false, msg: 'Acceso denegado' });
        }

        const datos = await leerBin();
        const cuenta = datos.users[u];
        if (!cuenta) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });

        const match = await bcrypt.compare(password, cuenta.passHash);
        if (!match) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });

        // Verificar si está bloqueado
        if (cuenta.bloqueado) return res.status(401).json({ ok: false, msg: 'Acceso bloqueado. Contactá a tu coach.' });

        // Verificar si la cuota está vencida
        if (cuenta.fechaInicio) {
            const inicio = new Date(cuenta.fechaInicio);
            const vence  = new Date(inicio);
            vence.setMonth(vence.getMonth() + 1);
            vence.setHours(0,0,0,0);
            const hoy = new Date();
            hoy.setHours(0,0,0,0);
            if (hoy >= vence) return res.status(401).json({ ok: false, msg: 'Cuota vencida. Contactá a tu coach.' });
        }

        res.json({ ok: true, role: cuenta.role, usuario: u, profe_asignado: cuenta.profe_asignado });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, msg: 'Error interno' });
    }
});

// GET DATOS — sin contraseñas, con nuevos campos
app.get('/api/datos', async (req, res) => {
    try {
        const datos = await leerBin();
        const usersSeguros = {};
        for (const u in datos.users) {
            const { passHash, ...resto } = datos.users[u];
            usersSeguros[u] = resto;
        }
        res.json({
            users:         usersSeguros,
            rutinas:       datos.rutinas       || {},
            historial:     datos.historial     || {},
            mensajeMaster: datos.mensajeMaster || '',
            recordes:      datos.recordes      || {},
            biblioteca:    datos.biblioteca    || []
        });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al leer datos' });
    }
});

// PUT DATOS — actualiza rutinas, historial, mensaje y récords
app.put('/api/datos', async (req, res) => {
    try {
        const datosActuales = await leerBin();
        const { rutinas, historial, mensajeMaster, recordes, biblioteca } = req.body;
        if (rutinas       !== undefined) datosActuales.rutinas       = rutinas;
        if (historial     !== undefined) datosActuales.historial      = historial;
        if (mensajeMaster !== undefined) datosActuales.mensajeMaster  = mensajeMaster;
        if (recordes      !== undefined) datosActuales.recordes       = recordes;
        if (biblioteca    !== undefined) datosActuales.biblioteca     = biblioteca;
        await escribirBin(datosActuales);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al guardar' });
    }
});

// GENERAR RUTINA CON IA
app.post('/api/generar-rutina', async (req, res) => {
    try {
        const { nivel, musculos, notasUsuario, ejerciciosDisponibles } = req.body;

        const prompt = `Sos un entrenador personal experto. Generá una rutina de gimnasio.

Nivel: ${nivel}
Músculos a trabajar: ${musculos}
${notasUsuario ? `Indicaciones: ${notasUsuario}` : ''}

Ejercicios disponibles (usá solo estos, con nombre exacto):
${ejerciciosDisponibles.join('\n')}

Devolvé SOLO JSON válido, sin texto extra ni backticks:
[{"nombre":"nombre exacto","series":4,"reps":"10-12","instrucciones":"instrucción breve"}]

Reglas: 4-7 ejercicios, series 3 o 4, reps según nivel, instrucción máximo 1 línea.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1000,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();
        const texto = data.content?.map(i => i.text || '').join('') || '';
        const jsonLimpio = texto.replace(/```json|```/g, '').trim();
        const rutina = JSON.parse(jsonLimpio);

        res.json({ ok: true, rutina });
    } catch (e) {
        console.error('Error generar rutina:', e);
        res.status(500).json({ ok: false, msg: 'Error al generar rutina' });
    }
});

// CREAR RUTINA EN BIBLIOTECA (solo dev)
app.post('/api/biblioteca', async (req, res) => {
    try {
        const { nombre, descripcion, objetivo, ejercicios } = req.body;
        const datos = await leerBin();
        if (!datos.biblioteca) datos.biblioteca = [];
        const nueva = {
            id:          Date.now().toString(),
            nombre,
            descripcion: descripcion || '',
            objetivo:    objetivo    || '',
            ejercicios:  ejercicios  || [],
            creadaEn:    new Date().toLocaleDateString('es-PY')
        };
        datos.biblioteca.push(nueva);
        await escribirBin(datos);
        res.json({ ok: true, rutina: nueva });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al crear rutina' });
    }
});

// EDITAR RUTINA DE BIBLIOTECA
app.put('/api/biblioteca/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, descripcion, objetivo, ejercicios } = req.body;
        const datos = await leerBin();
        const idx = (datos.biblioteca || []).findIndex(r => r.id === id);
        if (idx === -1) return res.status(404).json({ ok: false, msg: 'Rutina no encontrada' });
        datos.biblioteca[idx] = { ...datos.biblioteca[idx], nombre, descripcion, objetivo, ejercicios };
        await escribirBin(datos);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al editar rutina' });
    }
});

// ELIMINAR RUTINA DE BIBLIOTECA
app.delete('/api/biblioteca/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const datos = await leerBin();
        datos.biblioteca = (datos.biblioteca || []).filter(r => r.id !== id);
        await escribirBin(datos);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al eliminar rutina' });
    }
});

// CREAR USUARIO
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, foto, fechaInicio, bloqueado } = req.body;
        const u = usuario.toLowerCase().trim();
        const passHash = await bcrypt.hash(password, 10);
        const datos = await leerBin();
        datos.users[u] = {
            passHash,
            role,
            profe_asignado: role === 'alumno' ? profe_asignado : null,
            foto:        foto        || null,
            fechaInicio: fechaInicio || null,
            bloqueado:   bloqueado   || false
        };
        await escribirBin(datos);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al crear usuario' });
    }
});

// EDITAR USUARIO
app.put('/api/usuarios/:user', async (req, res) => {
    try {
        const oldU = req.params.user;
        const { nuevoUsuario, nuevaPassword, foto, fechaInicio, bloqueado, profe_asignado } = req.body;
        const newU = nuevoUsuario.toLowerCase().trim();
        const datos = await leerBin();
        const cuenta = datos.users[oldU];
        if (!cuenta) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

        const passHash = nuevaPassword === '_KEEP_'
            ? cuenta.passHash
            : await bcrypt.hash(nuevaPassword, 10);

        if (newU !== oldU) {
            datos.users[newU] = { ...cuenta, passHash,
                foto:           foto           !== undefined ? foto           : cuenta.foto,
                fechaInicio:    fechaInicio    !== undefined ? fechaInicio    : cuenta.fechaInicio,
                bloqueado:      bloqueado      !== undefined ? bloqueado      : cuenta.bloqueado,
                profe_asignado: profe_asignado !== undefined ? profe_asignado : cuenta.profe_asignado
            };
            if (datos.rutinas[oldU])   { datos.rutinas[newU]   = datos.rutinas[oldU];   delete datos.rutinas[oldU]; }
            if (datos.historial[oldU]) { datos.historial[newU] = datos.historial[oldU]; delete datos.historial[oldU]; }
            if (datos.recordes[oldU])  { datos.recordes[newU]  = datos.recordes[oldU];  delete datos.recordes[oldU]; }
            delete datos.users[oldU];
        } else {
            datos.users[oldU].passHash = passHash;
            if (foto           !== undefined) datos.users[oldU].foto           = foto;
            if (fechaInicio    !== undefined) datos.users[oldU].fechaInicio    = fechaInicio;
            if (bloqueado      !== undefined) datos.users[oldU].bloqueado      = bloqueado;
            if (profe_asignado !== undefined) datos.users[oldU].profe_asignado = profe_asignado;
        }

        await escribirBin(datos);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al editar usuario' });
    }
});

// ELIMINAR USUARIO
app.delete('/api/usuarios/:user', async (req, res) => {
    try {
        const u = req.params.user;
        const datos = await leerBin();
        delete datos.users[u];
        delete datos.recordes[u];
        await escribirBin(datos);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al eliminar usuario' });
    }
});

app.listen(PORT, () => console.log(`✅ Coach System v7.0.0 corriendo en puerto ${PORT}`));