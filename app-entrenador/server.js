// ============================================
//  COACH SYSTEM v8.0.0 - Backend MongoDB
//  Instalar dependencias: npm install
//  Correr: node server.js
// ============================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const fetch      = require('node-fetch');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// -- MIDDLEWARES --
app.use(cors({ origin: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ── MongoDB ──────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = 'aguila_corp';
let db = null;

async function conectarMongo() {
    if (db) return db;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ MongoDB conectado');
    return db;
}

async function getCol(nombre) {
    const database = await conectarMongo();
    return database.collection(nombre);
}

// ── LOGIN ────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const u = usuario.toLowerCase().trim();

        if (u === process.env.MASTER_USER) {
            const ok = await bcrypt.compare(password, process.env.MASTER_PASS_HASH);
            if (ok) return res.json({ ok: true, role: 'dev', usuario: u });
            return res.status(401).json({ ok: false, msg: 'Acceso denegado' });
        }

        const col = await getCol('users');
        const cuenta = await col.findOne({ _id: u });
        if (!cuenta) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });

        const match = await bcrypt.compare(password, cuenta.passHash);
        if (!match) return res.status(401).json({ ok: false, msg: 'Acceso denegado' });
        if (cuenta.bloqueado) return res.status(401).json({ ok: false, msg: 'Acceso bloqueado. Contactá a tu coach.' });

        if (cuenta.fechaInicio) {
            const vence = new Date(cuenta.fechaInicio);
            vence.setMonth(vence.getMonth() + 1);
            vence.setHours(0,0,0,0);
            const hoy = new Date(); hoy.setHours(0,0,0,0);
            if (hoy >= vence) return res.status(401).json({ ok: false, msg: 'Cuota vencida. Contactá a tu coach.' });
        }

        res.json({ ok: true, role: cuenta.role, usuario: u, profe_asignado: cuenta.profe_asignado });
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ ok: false, msg: 'Error interno' });
    }
});

// ── GET DATOS ────────────────────────────────────────────────────
app.get('/api/datos', async (req, res) => {
    try {
        const [colUsers, colRutinas, colHistorial, colRecordes, colConfig] = await Promise.all([
            getCol('users'), getCol('rutinas'), getCol('historial'),
            getCol('recordes'), getCol('config')
        ]);

        const [usersArr, rutinasArr, historialArr, recordesArr, configDoc] = await Promise.all([
            colUsers.find({}).toArray(),
            colRutinas.find({}).toArray(),
            colHistorial.find({}).toArray(),
            colRecordes.find({}).toArray(),
            colConfig.findOne({ _id: 'global' })
        ]);

        const users = {};
        usersArr.forEach(u => { const { _id, passHash, ...resto } = u; users[_id] = resto; });

        const rutinas = {};
        rutinasArr.forEach(r => { const { _id, ...resto } = r; rutinas[_id] = resto; });

        const historial = {};
        historialArr.forEach(h => { historial[h._id] = h.registros || []; });

        const recordes = {};
        recordesArr.forEach(r => { recordes[r._id] = r.datos || {}; });

        res.json({
            users, rutinas, historial, recordes,
            mensajeMaster: configDoc?.mensajeMaster || '',
            biblioteca:    configDoc?.biblioteca    || [],
            archivos:      configDoc?.archivos      || { fotos: [], gifs: [] }
        });
    } catch (e) {
        console.error('GET datos error:', e);
        res.status(500).json({ ok: false, msg: 'Error al leer datos' });
    }
});

// ── PUT DATOS ────────────────────────────────────────────────────
app.put('/api/datos', async (req, res) => {
    try {
        const { rutinas, historial, mensajeMaster, recordes, biblioteca, archivos } = req.body;

        if (rutinas !== undefined) {
            const col = await getCol('rutinas');
            const ops = Object.entries(rutinas).map(([usuario, datos]) => ({
                updateOne: {
                    filter: { _id: usuario },
                    update: { $set: { _id: usuario, ...datos } },
                    upsert: true
                }
            }));
            if (ops.length) await col.bulkWrite(ops);
        }

        if (historial !== undefined) {
            const col = await getCol('historial');
            const hace90 = new Date();
            hace90.setDate(hace90.getDate() - 90);
            const corte = hace90.toISOString().split('T')[0];
            const ops = Object.entries(historial).map(([usuario, registros]) => {
                let h = (registros || []).filter(r => !r.fecha_iso || r.fecha_iso >= corte);
                if (h.length > 300) h = h.slice(h.length - 300);
                return {
                    updateOne: {
                        filter: { _id: usuario },
                        update: { $set: { _id: usuario, registros: h } },
                        upsert: true
                    }
                };
            });
            if (ops.length) await col.bulkWrite(ops);
        }

        if (recordes !== undefined) {
            const col = await getCol('recordes');
            const ops = Object.entries(recordes).map(([usuario, datos]) => ({
                updateOne: {
                    filter: { _id: usuario },
                    update: { $set: { _id: usuario, datos } },
                    upsert: true
                }
            }));
            if (ops.length) await col.bulkWrite(ops);
        }

        const configUpdate = {};
        if (mensajeMaster !== undefined) configUpdate.mensajeMaster = mensajeMaster;
        if (biblioteca    !== undefined) configUpdate.biblioteca    = biblioteca;
        if (archivos      !== undefined) configUpdate.archivos      = archivos;
        if (Object.keys(configUpdate).length) {
            const col = await getCol('config');
            await col.updateOne({ _id: 'global' }, { $set: configUpdate }, { upsert: true });
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('PUT datos error:', e);
        res.status(500).json({ ok: false, msg: 'Error al guardar' });
    }
});

// ── GENERAR RUTINA IA ────────────────────────────────────────────
app.post('/api/generar-rutina', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const { nivel, musculos, notasUsuario, ejerciciosDisponibles } = req.body;
        const prompt = `Sos un entrenador personal experto. Generá una rutina de gimnasio.
Nivel: ${nivel}
Músculos: ${musculos}
${notasUsuario ? `Indicaciones: ${notasUsuario}` : ''}
Ejercicios disponibles (usá solo estos):
${ejerciciosDisponibles.join('\n')}
Devolvé SOLO JSON válido sin backticks:
[{"nombre":"nombre exacto","series":4,"reps":"10-12","instrucciones":"instrucción breve"}]
Reglas: 4-7 ejercicios, series 3 o 4, reps según nivel, instrucción 1 línea.`;

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
        const rutina = JSON.parse(texto.replace(/```json|```/g, '').trim());
        res.json({ ok: true, rutina });
    } catch (e) {
        console.error('Error generar rutina:', e);
        res.status(500).json({ ok: false, msg: 'Error al generar rutina' });
    }
});

// ── BIBLIOTECA ───────────────────────────────────────────────────
app.post('/api/biblioteca', async (req, res) => {
    try {
        const { nombre, descripcion, objetivo, ejercicios } = req.body;
        const nueva = {
            id: Date.now().toString(), nombre,
            descripcion: descripcion || '', objetivo: objetivo || '',
            ejercicios: ejercicios || [],
            creadaEn: new Date().toLocaleDateString('es-PY')
        };
        const col = await getCol('config');
        await col.updateOne({ _id: 'global' }, { $push: { biblioteca: nueva } }, { upsert: true });
        res.json({ ok: true, rutina: nueva });
    } catch (e) { res.status(500).json({ ok: false, msg: 'Error al crear rutina' }); }
});

app.put('/api/biblioteca/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, descripcion, objetivo, ejercicios } = req.body;
        const col = await getCol('config');
        await col.updateOne(
            { _id: 'global', 'biblioteca.id': id },
            { $set: {
                'biblioteca.$.nombre': nombre,
                'biblioteca.$.descripcion': descripcion || '',
                'biblioteca.$.objetivo': objetivo || '',
                'biblioteca.$.ejercicios': ejercicios || []
            }}
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, msg: 'Error al editar rutina' }); }
});

app.delete('/api/biblioteca/:id', async (req, res) => {
    try {
        const col = await getCol('config');
        await col.updateOne({ _id: 'global' }, { $pull: { biblioteca: { id: req.params.id } } });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, msg: 'Error al eliminar rutina' }); }
});

// ── USUARIOS ─────────────────────────────────────────────────────
app.post('/api/usuarios', async (req, res) => {
    try {
        const { usuario, password, role, profe_asignado, foto, fechaInicio, bloqueado } = req.body;
        const u = usuario.toLowerCase().trim();
        const passHash = await bcrypt.hash(password, 10);
        const col = await getCol('users');
        await col.updateOne(
            { _id: u },
            { $set: { _id: u, passHash, role,
                profe_asignado: role === 'alumno' ? (profe_asignado || null) : null,
                foto: foto || null, fechaInicio: fechaInicio || null, bloqueado: bloqueado || false
            }},
            { upsert: true }
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, msg: 'Error al crear usuario' }); }
});

app.put('/api/usuarios/:user', async (req, res) => {
    try {
        const oldU = req.params.user;
        const { nuevoUsuario, nuevaPassword, foto, fechaInicio, bloqueado, profe_asignado } = req.body;
        const newU = nuevoUsuario.toLowerCase().trim();
        const col  = await getCol('users');
        const cuenta = await col.findOne({ _id: oldU });
        if (!cuenta) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

        const passHash = nuevaPassword === '_KEEP_' ? cuenta.passHash : await bcrypt.hash(nuevaPassword, 10);
        const updateFields = { passHash };
        if (foto           !== undefined) updateFields.foto           = foto;
        if (fechaInicio    !== undefined) updateFields.fechaInicio    = fechaInicio;
        if (bloqueado      !== undefined) updateFields.bloqueado      = bloqueado;
        if (profe_asignado !== undefined) updateFields.profe_asignado = profe_asignado;

        if (newU !== oldU) {
            await col.insertOne({ ...cuenta, ...updateFields, _id: newU });
            await col.deleteOne({ _id: oldU });
            for (const colNombre of ['rutinas', 'historial', 'recordes']) {
                const c = await getCol(colNombre);
                const doc = await c.findOne({ _id: oldU });
                if (doc) { await c.insertOne({ ...doc, _id: newU }); await c.deleteOne({ _id: oldU }); }
            }
        } else {
            await col.updateOne({ _id: oldU }, { $set: updateFields });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('Edit user error:', e);
        res.status(500).json({ ok: false, msg: 'Error al editar usuario' });
    }
});

app.delete('/api/usuarios/:user', async (req, res) => {
    try {
        const u = req.params.user;
        await Promise.all([
            getCol('users').then(c => c.deleteOne({ _id: u })),
            getCol('rutinas').then(c => c.deleteOne({ _id: u })),
            getCol('historial').then(c => c.deleteOne({ _id: u })),
            getCol('recordes').then(c => c.deleteOne({ _id: u }))
        ]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, msg: 'Error al eliminar usuario' }); }
});

// ── MIGRACIÓN TEMPORAL (borrar después de usar) ──────────────────
app.get('/api/migrar-desde-jsonbin', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'aguila2025') return res.status(403).json({ ok: false, msg: 'No autorizado' });

    try {
        const API_KEY = process.env.JSONBIN_API_KEY;
        const BIN_ID  = process.env.JSONBIN_BIN_ID;

        if (!API_KEY || !BIN_ID) return res.status(500).json({ ok: false, msg: 'Faltan JSONBIN_API_KEY o JSONBIN_BIN_ID' });

        console.log('📦 Leyendo JSONBin...');
        const jsonRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
            headers: { 'X-Master-Key': API_KEY }
        });
        const json  = await jsonRes.json();
        const datos = json.record;
        if (!datos) return res.status(500).json({ ok: false, msg: 'JSONBin vacío o key inválida', raw: json });

        const log = [];
        log.push(`✅ JSONBin leído: ${Object.keys(datos.users||{}).length} usuarios`);

        // Usuarios
        const colUsers = await getCol('users');
        for (const [u, user] of Object.entries(datos.users || {})) {
            await colUsers.updateOne({ _id: u }, { $set: { _id: u, ...user } }, { upsert: true });
            log.push(`👤 ${u} (${user.role})`);
        }

        // Rutinas
        const colRutinas = await getCol('rutinas');
        for (const [u, rutina] of Object.entries(datos.rutinas || {})) {
            await colRutinas.updateOne({ _id: u }, { $set: { _id: u, ...rutina } }, { upsert: true });
            log.push(`📋 Rutinas de ${u}`);
        }

        // Historial
        const colHistorial = await getCol('historial');
        for (const [u, registros] of Object.entries(datos.historial || {})) {
            await colHistorial.updateOne({ _id: u }, { $set: { _id: u, registros: registros || [] } }, { upsert: true });
            log.push(`📊 Historial de ${u}: ${(registros||[]).length} registros`);
        }

        // Récords
        const colRecordes = await getCol('recordes');
        for (const [u, recordes] of Object.entries(datos.recordes || {})) {
            await colRecordes.updateOne({ _id: u }, { $set: { _id: u, datos: recordes } }, { upsert: true });
            log.push(`🏆 Récords de ${u}`);
        }

        // Config
        const colConfig = await getCol('config');
        await colConfig.updateOne(
            { _id: 'global' },
            { $set: {
                _id: 'global',
                mensajeMaster: datos.mensajeMaster || '',
                biblioteca:    datos.biblioteca    || [],
                archivos:      datos.archivos      || { fotos: [], gifs: [] }
            }},
            { upsert: true }
        );
        log.push('⚙️ Config global migrada');
        log.push('🎉 MIGRACIÓN COMPLETADA');

        res.json({ ok: true, log });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

app.listen(PORT, () => console.log(`✅ Coach System v8.0.0 en puerto ${PORT}`));