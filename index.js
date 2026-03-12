const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// --- Configuración de la API ---
const app = express();
app.use(cors()); // Permite que tu micrositio Next.js se comunique con esta API
app.use(express.json()); // Permite recibir datos en formato JSON
const PORT = 3001; // Usaremos el puerto 3001 para no chocar con Next.js (que usa el 3000)

let isBotReady = false; // Variable para saber si el bot ya cargó

// ==========================================
// CONFIGURACIÓN DE IA (GEMINI)
// ==========================================
// El modelo IA se inicializará dinámicamente usando la API Key que envíe el Micrositio web.


// Guardamos el historial de chat de Gemini
const chatSessions = {};
const conversationState = {};

// --- Configuración del Bot ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- Ayuda mucho en Render Free
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    }
});

client.on('qr', (qr) => {
    console.log('----------------------------------------------------');
    console.log('¡ATENCIÓN! Si no puedes escanear el código de abajo, abre este link:');
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    console.log('----------------------------------------------------');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('----------------------------------------------------');
    console.log('¡Conexión exitosa! ✅ El bot está listo.');
    isBotReady = true;
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    let number;
    try {
        const contact = await msg.getContact();
        number = contact.number;
        if (!number) {
            number = msg.from.split('@')[0];
        }
    } catch (err) {
        number = msg.from.split('@')[0];
    }

    console.log(`Mensaje recibido del contacto real ${number} (${msg.from}): ${msg.body}`);

    // Si nos contestan y ya habiamos iniciado conversacion desde el Micrositio
    if (conversationState[number]) {
        try {
            const uniName = conversationState[number].uniName;

            // Creamos sesión de IA si no existe
            if (!chatSessions[number]) {
                const sessionApiKey = conversationState[number].apiKey;

                if (!sessionApiKey) {
                    console.error(`[Bot-IA] No hay API Key configurada para ${number}. Usa la consola Web.`);
                    await client.sendMessage(msg.from, "Perdón, estoy teniendo un problema de configuración técnica. Por favor intenta más tarde.");
                    return;
                }

                const baseInstruction = conversationState[number].systemInstruction || "Eres un estudiante interesado en inscribirse.";
                const extractionRule = `\n\n[MISION OCULTA IMPERATIVA DEL SISTEMA]: 
Tu meta en esta conversación es ir preguntando naturalmente por TODAS las carreras en tu lista, una por una, y reunir EXCLUSIVAMENTE estos 6 datos precisos de CADA UNA:
1. "Carrera": El nombre de la carrera a la que corresponden los precios.
2. "Precio_carrera": Cuánto vale el programa.
3. "Descuento": Si tienen algún porcentaje, valor de descuento, o beca mencionada.
4. "Fechas_inicio": Cuándo inician clases o se cierran inscripciones.
5. "Doble_titulacion": Si ofrecen doble titulación (sí/no y detalles).
6. "Documentos_matricula": Qué documentos exactos piden para poder iniciar.

IMPORTANTE: Una vez sientas que la universidad TE HA DADO todos o la mayoría de esos datos DE TODAS LAS CARRERAS de tu lista, despídete de la universidad cordialmente, y EXACTAMENTE AL FINAL de tu última respuesta DEBES DEJAR UN ESPACIO Y añadir este bloque OBLIGATORIO en formato JSON válido (un ARREGLO de objetos):
[DATA] [ { "Carrera": "Nombre de la Carrera...", "Precio_carrera": "...", "Descuento": "...", "Fechas_inicio": "...", "Doble_titulacion": "...", "Documentos_matricula": "..." } ] [/DATA]
ESTE BLOQUE DEBE ESTAR AL FINAL EXACTAMENTE CON ESAS LLAVES DEL JSON FORMATO ARREGLO (iniciando con '[').`;

                const finalInstruction = baseInstruction + extractionRule;

                const isDeepSeek = sessionApiKey.startsWith('sk-');
                console.log(`[Bot-IA] Inicializando cerebro IA (${isDeepSeek ? 'DeepSeek' : 'Gemini'}) para conversar con ${uniName}...`);

                if (isDeepSeek) {
                    chatSessions[number] = {
                        provider: 'deepseek',
                        history: [
                            { role: "system", content: finalInstruction },
                            { role: "user", content: `Voy a contactar a la universidad: ${uniName}. ¿Entendido?` },
                            { role: "assistant", content: "Entendido. Sortearemos los menús automáticos para obtener los precios, carreras, fechas de inicio y convenios." }
                        ]
                    };
                } else {
                    const dynamicGenAI = new GoogleGenerativeAI(sessionApiKey);
                    const sessionModel = dynamicGenAI.getGenerativeModel({
                        model: 'gemini-2.5-flash',
                        systemInstruction: finalInstruction
                    });

                    chatSessions[number] = {
                        provider: 'gemini',
                        chatObj: sessionModel.startChat({
                            history: [
                                { role: "user", parts: [{ text: `Voy a contactar a la universidad: ${uniName}. ¿Entendido?` }] },
                                { role: "model", parts: [{ text: "Entendido. Sortearemos los menús automáticos para obtener los precios, carreras, fechas de inicio y convenios." }] }
                            ]
                        })
                    };
                }
            }

            console.log(`[Bot-IA] Pensando respuesta para ${uniName}...`);
            const chatObj = await msg.getChat();
            await chatObj.sendStateTyping(); // Simula "Escribiendo..." en WhatsApp

            let aiResponse = "";
            const sessionApiKey = conversationState[number].apiKey;

            if (chatSessions[number].provider === 'deepseek') {
                chatSessions[number].history.push({ role: "user", content: msg.body });

                // Petición nativa a DeepSeek (OpenAI format)
                const response = await fetch('https://api.deepseek.com/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${sessionApiKey}`
                    },
                    body: JSON.stringify({
                        model: 'deepseek-chat',
                        messages: chatSessions[number].history,
                        max_tokens: 300
                    })
                });
                const data = await response.json();
                if (data.error) throw new Error("DeepSeek Error: " + data.error.message);

                aiResponse = data.choices[0].message.content;
                chatSessions[number].history.push({ role: "assistant", content: aiResponse });
            } else {
                // Le damos el mensaje de la universidad a Gemini
                const result = await chatSessions[number].chatObj.sendMessage(msg.body);
                aiResponse = result.response.text();
            }

            // --- EXTRACCION DE DATOS FINALES ---
            // Buscamos si la IA imprimió el bloque oculto [DATA] JSON [/DATA]
            const dataRegex = /\[DATA\]([\s\S]*?)\[\/DATA\]/i;
            const match = aiResponse.match(dataRegex);

            if (match) {
                try {
                    const jsonStr = match[1].trim();
                    const extractedData = JSON.parse(jsonStr);

                    // Guardamos la información en un archivo JSON Maestro
                    const fs = require('fs');
                    const resultsFile = path.join(__dirname, 'resultados_extraidos.json');
                    let allResults = [];
                    if (fs.existsSync(resultsFile)) {
                        allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
                    }

                    const idx = allResults.findIndex(r => r.phone === number);
                    if (idx !== -1) {
                        allResults[idx].data = extractedData;
                        allResults[idx].updated_at = new Date().toISOString();
                    } else {
                        allResults.push({
                            uniName: conversationState[number].uniName,
                            phone: number,
                            data: extractedData,
                            created_at: new Date().toISOString()
                        });
                    }
                    fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
                    console.log(`[Bot-IA] ¡DATOS EXTRAIDOS EXITOSAMENTE para ${conversationState[number].uniName}! 🎉`, extractedData);

                } catch (err) {
                    console.error("[Bot-IA] Hubo un error parseando el JSON oculto de la IA:", err.message);
                }

                // Le quitamos el bloque de datos a la respuesta que finalmente verá la persona de WhatsApp
                aiResponse = aiResponse.replace(dataRegex, '').trim();

                // Por si acaso el bot no dijo nada mas aparte del JSON, le enviamos una despedida normal
                if (aiResponse === '') {
                    aiResponse = "Entendido, muchísimas gracias por toda la información compartida. ¡Feliz día!";
                }
            }
            // -----------------------------------

            // Esperamos un poco y lo mandamos
            setTimeout(async () => {
                await chatObj.clearState();
                await client.sendMessage(msg.from, aiResponse);
                console.log(`[Bot-IA] Respondido a ${number}: ${aiResponse}`);
            }, 3500 + Math.random() * 2000);

        } catch (error) {
            console.error('[Bot-IA] Error en Inteligencia Artificial:', error.message);

            // Si el error es por límite o cuota, actualizamos la base de datos para que la web lo sepa
            try {
                const fs = require('fs');
                const path = require('path');
                const p = path.join(__dirname, 'universities.txt');
                if (fs.existsSync(p)) {
                    let db = JSON.parse(fs.readFileSync(p, 'utf8'));
                    db = db.map(u =>
                        u.phone === number
                            ? { ...u, status: (error.message.includes('429') || error.message.toLowerCase().includes('quota') || error.message.toLowerCase().includes('balance')) ? 'limit_reached' : 'error' }
                            : u
                    );
                    fs.writeFileSync(p, JSON.stringify(db, null, 2));
                }
            } catch (e) { console.error('Error auto-update db:', e); }

            // Fallback para el usuario en WhatsApp
            await client.sendMessage(msg.from, "Disculpa, en este momento tengo demasiadas consultas acumuladas. ¿Podemos hablar más tarde?");
        }
    }

    if (msg.body === '!ping') {
        msg.reply('¡Hola! Soy tu bot automatizado respondiendo. 🤖 Pong!');
    }
});

// Iniciamos el bot
client.initialize();

// --- Rutas de la API (El "teléfono rojo") ---

// 1. Ruta para comprobar si el bot está vivo
app.get('/status', (req, res) => {
    res.json({ ready: isBotReady });
});

// 2. Ruta para ENVIAR mensajes (La que usará tu Micrositio)
app.post('/send-message', async (req, res) => {
    // Si el bot aún no inicia, no podemos enviar
    if (!isBotReady) {
        return res.status(503).json({ error: 'El bot aún no está listo. Espera un momento.' });
    }

    const { number, message, uniName, systemInstruction, apiKey } = req.body;

    // Validamos que nos manden el número y el mensaje
    if (!number || !message) {
        return res.status(400).json({ error: 'Falta el número (number) o el mensaje (message).' });
    }

    try {
        const chatId = `${number}@c.us`;

        // Enviamos el mensaje inicial!
        await client.sendMessage(chatId, message);
        console.log(`[Bot] Mensaje INICIAL enviado exitosamente a: ${number}`);

        // --- INICIO DE CONVERSACIÓN CON IA ---
        // Al enviar el primer mensaje desde tu web, inicializamos la "memoria", las
        // instrucciones maestras de la personalidad elegida y la API KEY para este contacto.
        conversationState[number] = {
            uniName: uniName || 'la Universidad',
            systemInstruction: systemInstruction || '',
            apiKey: apiKey || ''
        };

        // Borramos cualquier error viejo "Límite Agotado" que estuviera en la base de datos TXT
        try {
            const fs = require('fs');
            const path = require('path');
            const p = path.join(__dirname, 'universities.txt');
            if (fs.existsSync(p)) {
                let db = JSON.parse(fs.readFileSync(p, 'utf8'));
                db = db.map(u => u.phone === number ? { ...u, status: 'success' } : u);
                fs.writeFileSync(p, JSON.stringify(db, null, 2));
            }
        } catch (e) { }

        res.json({ success: true, message: 'Mensaje inicial enviado y conversación secuencial iniciada!' });

    } catch (error) {
        console.error('Error al enviar el mensaje:', error);
        res.status(500).json({ error: 'No se pudo enviar el mensaje.' });
    }
});

// 3. Rutas para Base de Datos Local
const dbPath = path.join(__dirname, 'universities.txt');

app.get('/database', (req, res) => {
    try {
        if (!fs.existsSync(dbPath)) {
            // Data inicial por defecto
            const defaultData = [
                { id: 1, name: 'Universidad CUN (Edwar)', phone: '573160439644', status: 'pending' },
                { id: 2, name: 'Universidad del Rosario (David)', phone: '573213461198', status: 'pending' },
                { id: 3, name: 'Universidad de Barranquilla (Dylan)', phone: '573213461198', status: 'pending' },
                { id: 4, name: 'Universidad de Cartagena (Ernesto)', phone: '573005039342', status: 'pending' },
                { id: 5, name: 'Universidad de Cali (Sharon)', phone: '573137314284', status: 'pending' },
                { id: 6, name: 'CECAR (Yeison)', phone: '573228469814', status: 'pending' },
                { id: 7, name: 'Universidad de Antioquia (Santiago)', phone: '573013710956', status: 'pending' }
            ];
            fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
            return res.json(defaultData);
        }
        const fileContent = fs.readFileSync(dbPath, 'utf8');
        res.json(JSON.parse(fileContent));
    } catch (error) {
        console.error('Error leyendo TXT:', error);
        res.status(500).json({ error: 'Fallo al leer la base de datos TXT.' });
    }
});

app.post('/database', (req, res) => {
    try {
        const newData = req.body;
        fs.writeFileSync(dbPath, JSON.stringify(newData, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('Error guardando en TXT:', error);
        res.status(500).json({ error: 'Fallo al escribir la base de datos TXT.' });
    }
});

// 4. Rutas para Base de Datos de Resultados JSON
const resultsPath = path.join(__dirname, 'resultados_extraidos.json');

app.get('/results', (req, res) => {
    try {
        if (!fs.existsSync(resultsPath)) {
            return res.json([]);
        }
        res.json(JSON.parse(fs.readFileSync(resultsPath, 'utf8')));
    } catch (e) {
        res.status(500).json({ error: 'Fallo al leer los resultados' });
    }
});

app.post('/results', (req, res) => {
    try {
        fs.writeFileSync(resultsPath, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Fallo al escribir resultados' });
    }
});

// Arrancamos el servidor API
app.listen(PORT, () => {
    console.log(`🚀 API del Bot corriendo en http://localhost:${PORT}`);
});
