// ============================================
//  SCRIPT DE MIGRACIÓN JSONBin → MongoDB
//  Correr UNA SOLA VEZ: node migrar.js
// ============================================

const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');
const fs = require('fs');

// Leer credenciales del archivo .env
require('dotenv').config();

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const MONGO_URI       = process.env.MONGO_URI;
const DB_NAME         = 'aguila_corp';

async function migrar() {
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID || !MONGO_URI) {
        console.error('❌ Faltan variables de entorno. Verificá el archivo .env');
        process.exit(1);
    }

    console.log('📦 Leyendo datos de JSONBin...');
    const res  = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    const json = await res.json();
    const datos = json.record;

    if (!datos) { console.error('❌ No se pudo leer JSONBin'); process.exit(1); }
    console.log('✅ JSONBin leído');
    console.log(`   Usuarios: ${Object.keys(datos.users || {}).length}`);
    console.log(`   Con rutinas: ${Object.keys(datos.rutinas || {}).length}`);
    console.log(`   Biblioteca: ${(datos.biblioteca || []).length} rutinas`);

    console.log('\n🔌 Conectando a MongoDB...');
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    console.log('✅ MongoDB conectado');

    // Usuarios
    console.log('\n👤 Migrando usuarios...');
    const colUsers = db.collection('users');
    for (const [username, user] of Object.entries(datos.users || {})) {
        await colUsers.updateOne({ _id: username }, { $set: { _id: username, ...user } }, { upsert: true });
        console.log(`   ✅ ${username} (${user.role})`);
    }

    // Rutinas
    console.log('\n📋 Migrando rutinas...');
    const colRutinas = db.collection('rutinas');
    for (const [username, rutina] of Object.entries(datos.rutinas || {})) {
        await colRutinas.updateOne({ _id: username }, { $set: { _id: username, ...rutina } }, { upsert: true });
        console.log(`   ✅ Rutinas de ${username}`);
    }

    // Historial
    console.log('\n📊 Migrando historial...');
    const colHistorial = db.collection('historial');
    for (const [username, registros] of Object.entries(datos.historial || {})) {
        await colHistorial.updateOne({ _id: username }, { $set: { _id: username, registros: registros || [] } }, { upsert: true });
        console.log(`   ✅ Historial de ${username}: ${(registros || []).length} registros`);
    }

    // Récords
    console.log('\n🏆 Migrando récords...');
    const colRecordes = db.collection('recordes');
    for (const [username, recordes] of Object.entries(datos.recordes || {})) {
        await colRecordes.updateOne({ _id: username }, { $set: { _id: username, datos: recordes } }, { upsert: true });
        console.log(`   ✅ Récords de ${username}`);
    }

    // Config global
    console.log('\n⚙️ Migrando configuración...');
    const colConfig = db.collection('config');
    await colConfig.updateOne(
        { _id: 'global' },
        { $set: {
            _id:           'global',
            mensajeMaster: datos.mensajeMaster || '',
            biblioteca:    datos.biblioteca    || [],
            archivos:      datos.archivos      || { fotos: [], gifs: [] }
        }},
        { upsert: true }
    );
    console.log('   ✅ Configuración global migrada');

    await client.close();
    console.log('\n🎉 MIGRACIÓN COMPLETADA EXITOSAMENTE');
    console.log('   Borrá migrar.js y .env cuando termines.');
}

migrar().catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
});