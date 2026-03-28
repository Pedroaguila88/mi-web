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
    return data.record || { users: {}, rutinas: {}, historial: {}, mensajeMaster: '', recordes: {} };
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
            recordes:      datos.recordes      || {}
        });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al leer datos' });
    }
});

// PUT DATOS — actualiza rutinas, historial, mensaje y récords
app.put('/api/datos', async (req, res) => {
    try {
        const datosActuales = await leerBin();
        const { rutinas, historial, mensajeMaster, recordes } = req.body;
        if (rutinas       !== undefined) datosActuales.rutinas       = rutinas;
        if (historial     !== undefined) datosActuales.historial      = historial;
        if (mensajeMaster !== undefined) datosActuales.mensajeMaster  = mensajeMaster;
        if (recordes      !== undefined) datosActuales.recordes       = recordes;
        await escribirBin(datosActuales);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: 'Error al guardar' });
    }
});

// CREAR USUARIO
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, foto } = req.body;
        const u = usuario.toLowerCase().trim();
        const passHash = await bcrypt.hash(password, 10);
        const datos = await leerBin();
        datos.users[u] = { passHash, role, profe_asignado: role === 'alumno' ? profe_asignado : null, foto: foto || null };
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
        const { nuevoUsuario, nuevaPassword, foto } = req.body;
        const newU = nuevoUsuario.toLowerCase().trim();
        const datos = await leerBin();
        const cuenta = datos.users[oldU];
        if (!cuenta) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

        // Si la contraseña es _KEEP_ solo actualiza otros campos sin tocar el hash
        const passHash = nuevaPassword === '_KEEP_'
            ? cuenta.passHash
            : await bcrypt.hash(nuevaPassword, 10);

        if (newU !== oldU) {
            datos.users[newU] = { ...cuenta, passHash, foto: foto !== undefined ? foto : cuenta.foto };
            if (datos.rutinas[oldU])   { datos.rutinas[newU]   = datos.rutinas[oldU];   delete datos.rutinas[oldU]; }
            if (datos.historial[oldU]) { datos.historial[newU] = datos.historial[oldU]; delete datos.historial[oldU]; }
            if (datos.recordes[oldU])  { datos.recordes[newU]  = datos.recordes[oldU];  delete datos.recordes[oldU]; }
            delete datos.users[oldU];
        } else {
            datos.users[oldU].passHash = passHash;
            if (foto !== undefined) datos.users[oldU].foto = foto;
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
