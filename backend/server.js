/**
 * ============================================================================
 *  SISTEMA DE ADMISIÓN HOSPITALARIA - BACKEND
 *  Node.js + Express + SQLite + Google Gemini
 * ----------------------------------------------------------------------------
 *  - Extracción estructurada de historias clínicas peruanas (MINSA / EsSalud)
 *  - Respuesta JSON nativa de Gemini (responseMimeType + responseSchema)
 *  - Regla de oro: todo campo vacío se guarda como "No registrado"
 *  - Migración automática del esquema (bases de datos antiguas incluidas)
 *  - Agrupación estable de pacientes mediante "clave_paciente"
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

// ----------------------------------------------------------------------------
// 1. CONFIGURACIÓN GENERAL
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const MODELO = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const NO_REGISTRADO = 'No registrado';

const RUTA_DB = process.env.DB_PATH || path.join(__dirname, 'hospital.db');
const DIR_SUBIDAS = path.join(__dirname, 'uploads');
const DIR_FRONTEND = path.join(__dirname, '..', 'frontend');

const TAMANO_MAXIMO = 25 * 1024 * 1024; // 25 MB

// MIME types aceptados por la API de Gemini (documentos e imágenes escaneadas)
const MIMES_PERMITIDOS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

if (!process.env.GEMINI_API_KEY) {
  console.error(
    '\n[FATAL] Falta GEMINI_API_KEY en el archivo backend/.env\n' +
    '        Agrega:  GEMINI_API_KEY=tu_clave_de_google_ai_studio\n'
  );
  process.exit(1);
}

if (!fs.existsSync(DIR_SUBIDAS)) fs.mkdirSync(DIR_SUBIDAS, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const db = new sqlite3.Database(RUTA_DB);

// ----------------------------------------------------------------------------
// 2. ESQUEMA DE BASE DE DATOS (con migración automática)
// ----------------------------------------------------------------------------
const CAMPOS_CLINICOS = [
  'nombre',
  'documento',
  'fecha_ingreso',
  'edad',
  'sexo',
  'motivo_consulta',
  'enfermedad_actual',
  'signos_vitales',
  'diagnostico',
  'plan_tratamiento',
  'medico',
];

const COLUMNAS = {
  nombre: 'TEXT',
  documento: 'TEXT',
  fecha_ingreso: 'TEXT',
  edad: 'TEXT',
  sexo: 'TEXT',
  motivo_consulta: 'TEXT',
  enfermedad_actual: 'TEXT',
  signos_vitales: 'TEXT',
  diagnostico: 'TEXT',
  plan_tratamiento: 'TEXT',
  medico: 'TEXT',
  creado_en: 'TEXT',
};

function ejecutar(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function consultar(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, filas) => {
      if (error) reject(error);
      else resolve(filas);
    });
  });
}

async function inicializarBaseDeDatos() {
  await ejecutar(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      documento TEXT,
      fecha_ingreso TEXT,
      edad TEXT,
      sexo TEXT,
      motivo_consulta TEXT,
      enfermedad_actual TEXT,
      signos_vitales TEXT,
      diagnostico TEXT,
      plan_tratamiento TEXT,
      medico TEXT,
      creado_en TEXT
    )
  `);

  // Si la base viene de una versión antigua (p. ej. solo 6 columnas),
  // agregamos las que falten sin borrar información existente.
  const columnasActuales = await consultar('PRAGMA table_info(pacientes)');
  const existentes = new Set(columnasActuales.map((c) => c.name));

  for (const [nombre, tipo] of Object.entries(COLUMNAS)) {
    if (!existentes.has(nombre)) {
      await ejecutar(`ALTER TABLE pacientes ADD COLUMN ${nombre} ${tipo}`);
      console.log(`[DB] Columna agregada: ${nombre}`);
    }
  }

  await ejecutar('CREATE INDEX IF NOT EXISTS idx_pacientes_documento ON pacientes(documento)');
}

// ----------------------------------------------------------------------------
// 3. NORMALIZACIÓN DE DATOS (regla de oro: nunca null / vacío)
// ----------------------------------------------------------------------------
const VALORES_VACIOS = /^(|null|undefined|n\/?a|s\/?d|s\/?n|sin\s+dato(s)?|sin\s+informaci[oó]n|sin\s+registro|no\s+consigna(do)?|no\s+se\s+registra|no\s+registrado|-+|\.+|\?+)$/i;

/** Convierte cualquier valor en texto limpio o "No registrado". */
function limpiarTexto(valor) {
  if (valor === null || valor === undefined) return NO_REGISTRADO;

  let texto = String(valor)
    .replace(/\u0000/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Artefactos de markdown que a veces escapan al JSON
  texto = texto.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  if (VALORES_VACIOS.test(texto)) return NO_REGISTRADO;
  return texto;
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

function fechaValida(anio, mes, dia) {
  const y = Number(anio);
  const m = Number(mes);
  const d = Number(dia);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const fecha = new Date(Date.UTC(y, m - 1, d));
  if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${dosDigitos(m)}-${dosDigitos(d)}`;
}

const MESES_TEXTO = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/**
 * Normaliza cualquier fecha a ISO (YYYY-MM-DD), ordenable y compatible con SQLite.
 * Acepta: 2016-03-18, 18/03/2016, 18-03-16, "18 de marzo de 2016", "2016-03-18 11:30".
 */
function normalizarFecha(valor) {
  const texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return NO_REGISTRADO;

  // ISO: 2016-03-18 (con o sin hora)
  let coincidencia = texto.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (coincidencia) {
    const iso = fechaValida(coincidencia[1], coincidencia[2], coincidencia[3]);
    if (iso) return iso;
  }

  // DD/MM/AAAA o DD-MM-AA
  coincidencia = texto.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (coincidencia) {
    let anio = Number(coincidencia[3]);
    if (anio < 100) anio += anio > 69 ? 1900 : 2000;
    const iso = fechaValida(anio, coincidencia[2], coincidencia[1]);
    if (iso) return iso;
  }

  // "18 de marzo de 2016"
  coincidencia = texto.match(/(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]+)\s*(?:de\s+|del\s+)?(\d{4})/i);
  if (coincidencia) {
    const mes = MESES_TEXTO[coincidencia[2].toLowerCase()];
    if (mes) {
      const iso = fechaValida(coincidencia[3], mes, coincidencia[1]);
      if (iso) return iso;
    }
  }

  return texto; // Se conserva el texto original si es una fecha no reconocida
}

function normalizarEdad(valor) {
  const texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return NO_REGISTRADO;

  let edad = texto
    .replace(/\bde\s+edad\b/gi, '')
    .replace(/\ba[nñ]os\b/gi, 'años')
    .replace(/\s+/g, ' ')
    .trim();

  // "10" -> "10 años"
  if (/^\d{1,3}$/.test(edad)) {
    const n = Number(edad);
    if (n >= 0 && n <= 120) return `${n} años`;
  }

  return edad;
}

function normalizarSexo(valor) {
  const texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return NO_REGISTRADO;

  const t = texto.toLowerCase();
  if (/^(m|masculino|hombre|var[oó]n|masc\.?)$/.test(t)) return 'Masculino';
  if (/^(f|femenino|mujer|fem\.?)$/.test(t)) return 'Femenino';
  return texto;
}

/** Deja el documento en un formato estable: "46359034", "00000002" */
function limpiarDocumento(valor) {
  let texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return NO_REGISTRADO;

  // Quita etiquetas del tipo "DNI:", "HC N°", "Historia Clínica", "SIS"
  texto = texto.replace(
    /^(n[°ºo]?\s*de\s*)?(dni|d\.n\.i\.?|documento(\s+de\s+identidad)?|h\.?c\.?|historia\s+cl[ií]nica|sis|ce|pasaporte)\s*[:#n°º\-]?\s*/i,
    ''
  );

  const token = texto.match(/[A-Za-z0-9][A-Za-z0-9.\-]{2,}/);
  if (token) return token[0].replace(/\./g, '').toUpperCase();

  return texto;
}

function normalizarDocumentoClave(valor) {
  const texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return '';
  const limpio = texto.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return limpio.length >= 3 ? limpio : '';
}

function normalizarNombreClave(valor) {
  const texto = limpiarTexto(valor);
  if (texto === NO_REGISTRADO) return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function calcularClavePaciente(paciente) {
  const documento = normalizarDocumentoClave(paciente.documento);
  if (documento) return `doc:${documento}`;

  const nombre = normalizarNombreClave(paciente.nombre);
  if (nombre) return `nom:${nombre}`;

  return `sin:${paciente.id || 'desconocido'}`;
}

function normalizarExtraccion(datos) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    throw new ErrorHttp(502, 'La IA devolvió una estructura inesperada. Intenta nuevamente.', 'RESPUESTA_INVALIDA');
  }

  const limpio = {};

  for (const campo of CAMPOS_CLINICOS) {
    let valor = datos[campo];

    if (Array.isArray(valor)) {
      valor = valor
        .map((item) => (item && typeof item === 'object' ? Object.values(item).join(' ') : item))
        .join('; ');
    } else if (valor && typeof valor === 'object') {
      valor = Object.values(valor).join('; ');
    }

    limpio[campo] = limpiarTexto(valor);
  }

  limpio.nombre = limpiarTexto(limpio.nombre);
  limpio.documento = limpiarDocumento(limpio.documento);
  limpio.fecha_ingreso = normalizarFecha(limpio.fecha_ingreso);
  limpio.edad = normalizarEdad(limpio.edad);
  limpio.sexo = normalizarSexo(limpio.sexo);

  return limpio;
}

function normalizarFila(fila) {
  const limpio = {
    id: fila.id,
    creado_en: fila.creado_en || null,
  };

  for (const campo of CAMPOS_CLINICOS) {
    limpio[campo] = campo === 'fecha_ingreso'
      ? normalizarFecha(fila[campo])
      : limpiarTexto(fila[campo]);
  }

  limpio.documento = limpiarDocumento(limpio.documento);
  limpio.edad = normalizarEdad(limpio.edad);
  limpio.sexo = normalizarSexo(limpio.sexo);
  limpio.clave_paciente = calcularClavePaciente(limpio);

  return limpio;
}

function ordenarPorFechaDescendente(a, b) {
  const patronISO = /^\d{4}-\d{2}-\d{2}$/;
  const fechaA = patronISO.test(a.fecha_ingreso) ? a.fecha_ingreso : null;
  const fechaB = patronISO.test(b.fecha_ingreso) ? b.fecha_ingreso : null;

  if (fechaA && fechaB) return fechaB.localeCompare(fechaA) || b.id - a.id;
  if (fechaA) return -1;
  if (fechaB) return 1;
  return b.id - a.id;
}


const PROMPT = `Eres un experto en digitalización de historias clínicas del sistema de salud peruano (MINSA, EsSalud, SIS y clínicas privadas). Recibirás una o varias imágenes/PDF escaneados de formatos como:
- "Formato de Historia Clínica de la Niña y el Niño" (MINSA / Red de Salud Lima Sur)
- "Historia Clínica - Información Básica" e "Historia Médica Actual" (EsSalud)
- Hojas de atención, fichas de emergencia, historias clínicas generales y similares.

OBJETIVO
Extraer los datos de UNA sola atención médica del PACIENTE TITULAR y devolverlos EXCLUSIVAMENTE en el JSON solicitado.

REGLAS DE LECTURA (OBLIGATORIAS)
1. Recorre el documento completo, página por página y sección por sección: datos generales / filiación, anamnesis, antecedentes, examen físico, signos vitales, diagnóstico, plan de trabajo, exámenes auxiliares y firmas.
2. Las casillas pueden estar marcadas con X, x, ✓, ✔, aspa, círculo, subrayado, sombreado o texto manuscrito. Interpreta esa marca como la opción seleccionada del campo que está inmediatamente a su izquierda, arriba o en la misma fila.
3. Respeta la relación etiqueta → valor. En formularios con columnas, el valor está a la derecha o debajo de su etiqueta; no mezcles valores de filas vecinas.
4. Los formatos peruanos suelen escribir primero los APELLIDOS y luego los NOMBRES. Devuelve el campo "nombre" en orden natural: Nombres + apellido paterno + apellido materno, sin comas ni etiquetas.
5. No confundas al paciente con el acompañante, la madre, el padre, el apoderado, el responsable, el informante ni el médico. El paciente es el titular de la historia.
6. Ignora el texto preimpreso del formato (rangos de referencia, instrucciones, códigos de versión, numeración de páginas, membretes). Prioriza los datos manuscritos o llenados.
7. Si el documento contiene varias atenciones o fechas, extrae SOLO la más reciente (mayor fecha y hora). No mezcles datos de atenciones distintas.
8. No inventes, no supongas y no completes valores "probables". Registra únicamente lo que el documento sustenta de forma legible.
9. Normaliza abreviaturas médicas solo cuando sean inequívocas: T° = temperatura, FC = frecuencia cardiaca, FR = frecuencia respiratoria, PA = presión arterial, SpO2 = saturación, H.C. = historia clínica, DNI = documento nacional de identidad.

REGLA DE ORO (SIN EXCEPCIONES)
- Todas las claves del JSON deben existir SIEMPRE y su valor debe ser un string.
- Si un dato no aparece, está en blanco, es ilegible o no aplica, escribe exactamente: "No registrado".
- NUNCA devuelvas null, "", [], {}, "N/A", "---" ni omitas claves.
- No copies texto preimpresionado como si fuera un dato del paciente.

DEFINICIÓN DE CADA CAMPO
- nombre: Nombre completo del paciente (nombres + apellidos). Sin números de documento ni etiquetas.
- documento: Número de identificación del paciente. Prioridad: DNI > N° de Historia Clínica > SIS > otro. Devuelve solo el número, sin prefijos ni puntos.
- fecha_ingreso: Fecha de la ATENCIÓN (no la de nacimiento). Formato YYYY-MM-DD. Si hay varias, la más reciente. Si no hay ninguna, "No registrado".
- edad: Edad al momento de la atención, normalizada como "10 años", "8 meses" o "3 días". Si no figura pero hay fecha de nacimiento y fecha de atención, calcúlala. Si no, "No registrado".
- sexo: "Masculino" o "Femenino". Si no es determinable, "No registrado".
- motivo_consulta: Motivo de ingreso, queja principal o síntomas principales, en una o dos frases.
- enfermedad_actual: Relato cronológico de la enfermedad actual: tiempo de enfermedad, inicio, curso, síntomas acompañantes, tratamientos previos y evolución. Si el formato lo divide ("Relato cronológico", "Enfermedad actual", "Padecimiento actual"), intégralos en un solo texto coherente.
- signos_vitales: Solo los valores medidos, con este formato: "T: 37.8 °C | FC: 94 lpm | FR: 20 rpm | PA: 104/68 mmHg | SpO2: 98% | Peso: 32 kg | Talla: 138 cm". Incluye únicamente los que aparezcan; si no hay ninguno, "No registrado". No confundas los rangos de referencia impresos con los valores del paciente.
- diagnostico: Impresión diagnóstica, presunciones diagnósticas y códigos CIE-10 si figuran, separados por "; ".
- plan_tratamiento: Plan de trabajo, exámenes auxiliares solicitados, tratamiento/receta, indicaciones, interconsultas y recomendaciones, separados por "; ".
- medico: Nombre del médico tratante o del profesional responsable, con número de colegiatura si aparece. No uses el nombre del familiar ni del informante.

Devuelve únicamente el objeto JSON, en español, sin bloques de código ni comentarios.`;

const REFUERZO_JSON = `La respuesta anterior no pudo interpretarse como JSON. Devuelve EXCLUSIVAMENTE un objeto JSON válido con las 11 claves solicitadas, con valores string, usando "No registrado" en los campos faltantes. Sin markdown, sin texto adicional.`;

const ESQUEMA_RESPUESTA = {
  type: SchemaType.OBJECT,
  properties: {
    nombre: { type: SchemaType.STRING, description: 'Nombre completo del paciente (nombres y apellidos).' },
    documento: { type: SchemaType.STRING, description: 'DNI, historia clínica u otro documento. Solo el número.' },
    fecha_ingreso: { type: SchemaType.STRING, description: 'Fecha de la atención en formato YYYY-MM-DD.' },
    edad: { type: SchemaType.STRING, description: 'Edad normalizada, por ejemplo "10 años".' },
    sexo: { type: SchemaType.STRING, description: 'Masculino o Femenino.' },
    motivo_consulta: { type: SchemaType.STRING, description: 'Motivo de consulta o ingreso.' },
    enfermedad_actual: { type: SchemaType.STRING, description: 'Relato cronológico de la enfermedad actual.' },
    signos_vitales: { type: SchemaType.STRING, description: 'Signos vitales medidos, separados por |.' },
    diagnostico: { type: SchemaType.STRING, description: 'Impresión diagnóstica, separada por ;.' },
    plan_tratamiento: { type: SchemaType.STRING, description: 'Plan de trabajo, tratamiento e indicaciones.' },
    medico: { type: SchemaType.STRING, description: 'Médico tratante o profesional responsable.' },
  },
  required: CAMPOS_CLINICOS,
};


class ErrorHttp extends Error {
  constructor(status, mensaje, codigo = 'ERROR') {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

function estadoHttpDeError(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? null;
}

function esErrorReintentable(error) {
  const status = estadoHttpDeError(error);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /overloaded|unavailable|timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(
    String(error?.message || '')
  );
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function traducirErrorIA(error) {
  const status = estadoHttpDeError(error);
  const mensaje = String(error?.message || '');

  if (status === 503 || /overloaded|unavailable/i.test(mensaje)) {
    return new ErrorHttp(503, 'El servicio de IA está saturado en este momento. Espera un minuto e intenta nuevamente.', 'IA_SATURADA');
  }
  if (status === 429 || /quota|rate limit/i.test(mensaje)) {
    return new ErrorHttp(429, 'Se alcanzó el límite de solicitudes de la API de Gemini. Espera unos minutos e intenta nuevamente.', 'CUOTA_EXCEDIDA');
  }
  if (status === 401 || status === 403) {
    return new ErrorHttp(502, 'La clave de API de Gemini no es válida o no tiene permisos para este modelo.', 'API_KEY_INVALIDA');
  }
  if (status === 400) {
    return new ErrorHttp(422, 'Gemini no pudo procesar el documento. Verifica que el archivo no esté dañado o protegido con contraseña.', 'DOCUMENTO_RECHAZADO');
  }
  if (status === 404 || /model.*not found|not found for API version/i.test(mensaje)) {
    return new ErrorHttp(502, `El modelo de IA "${MODELO}" no está disponible. Configura GEMINI_MODEL en el archivo .env.`, 'MODELO_NO_DISPONIBLE');
  }
  if (error?.name === 'GoogleGenerativeAIAbortError' || /timeout|ETIMEDOUT|aborted/i.test(mensaje)) {
    return new ErrorHttp(504, 'La IA tardó demasiado en responder. Intenta nuevamente con un archivo más liviano.', 'TIEMPO_AGOTADO');
  }

  return new ErrorHttp(502, 'No se pudo procesar el documento con IA. Intenta nuevamente.', 'IA_ERROR');
}


const almacenamiento = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIR_SUBIDAS),
  filename: (req, file, cb) => {
    const extension = MIMES_PERMITIDOS[file.mimetype] || path.extname(file.originalname || '').toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

const subirArchivo = multer({
  storage: almacenamiento,
  limits: { fileSize: TAMANO_MAXIMO, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!MIMES_PERMITIDOS[file.mimetype]) {
      return cb(new ErrorHttp(
        415,
        'Formato no soportado. Sube un PDF, JPG, PNG o WEBP.',
        'FORMATO_NO_SOPORTADO'
      ));
    }
    cb(null, true);
  },
});

const camposDeArchivo = subirArchivo.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'archivo', maxCount: 1 },
  { name: 'documento', maxCount: 1 },
  { name: 'file', maxCount: 1 },
]);

function obtenerArchivoSubido(req) {
  if (req.file) return req.file;
  if (!req.files) return null;
  for (const lista of Object.values(req.files)) {
    if (Array.isArray(lista) && lista.length > 0) return lista[0];
  }
  return null;
}

function borrarArchivo(ruta) {
  try {
    if (ruta && fs.existsSync(ruta)) fs.unlinkSync(ruta);
  } catch (error) {
    console.warn(`[AVISO] No se pudo eliminar el archivo temporal: ${error.message}`);
  }
}

async function prepararArchivoEnGemini(ruta, mimeType, nombreOriginal) {
  const subida = await fileManager.uploadFile(ruta, {
    mimeType,
    displayName: nombreOriginal || 'documento-clinico',
  });

  let archivo = subida.file;
  const inicio = Date.now();
  const LIMITE_ESPERA = 90_000;

  while (archivo.state === 'PROCESSING' && Date.now() - inicio < LIMITE_ESPERA) {
    await esperar(2000);
    archivo = await fileManager.getFile(archivo.name);
  }

  if (archivo.state === 'FAILED') {
    throw new ErrorHttp(
      422,
      'Gemini no pudo leer el archivo. Verifica que el PDF no esté dañado ni protegido con contraseña.',
      'ARCHIVO_ILEGIBLE'
    );
  }

  return archivo;
}

function extraerTextoRespuesta(resultado) {
  const respuesta = resultado.response;

  const bloqueo = respuesta.promptFeedback?.blockReason;
  if (bloqueo) {
    throw new ErrorHttp(
      422,
      `La IA bloqueó el contenido del documento (motivo: ${bloqueo}). Intenta con otra versión del archivo.`,
      'CONTENIDO_BLOQUEADO'
    );
  }

  const candidato = respuesta.candidates?.[0];
  const finalizacion = candidato?.finishReason;

  if (finalizacion === 'SAFETY' || finalizacion === 'RECITATION' || finalizacion === 'BLOCKLIST') {
    throw new ErrorHttp(422, 'La IA no pudo procesar el contenido por sus filtros de seguridad.', 'CONTENIDO_BLOQUEADO');
  }

  let texto = '';
  try {
    texto = respuesta.text() || '';
  } catch (error) {
    throw new ErrorHttp(502, 'La IA no devolvió contenido legible para este documento.', 'RESPUESTA_VACIA');
  }

  if (!texto.trim()) {
    const detalle = finalizacion === 'MAX_TOKENS'
      ? 'La respuesta de la IA se truncó por longitud. Intenta con un documento más corto.'
      : 'La IA no devolvió contenido para este documento.';
    throw new ErrorHttp(502, detalle, 'RESPUESTA_VACIA');
  }

  return texto;
}

function limpiarBloquesJSON(texto) {
  let limpio = String(texto || '').trim();
  limpio = limpio.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio !== -1 && fin > inicio) limpio = limpio.slice(inicio, fin + 1);

  return limpio;
}

async function generarConReintentos(modelo, partes) {
  const INTENTOS = 3;
  let ultimoError;

  for (let intento = 1; intento <= INTENTOS; intento += 1) {
    try {
      return await modelo.generateContent(partes, { timeout: 120_000 });
    } catch (error) {
      ultimoError = error;
      if (!esErrorReintentable(error) || intento === INTENTOS) throw error;
      console.warn(`[IA] Reintento ${intento}/${INTENTOS - 1} por error transitorio...`);
      await esperar(1500 * 2 ** (intento - 1));
    }
  }

  throw ultimoError;
}

async function analizarDocumento(archivoGemini) {
  const modelo = genAI.getGenerativeModel({
    model: MODELO,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ESQUEMA_RESPUESTA,
      temperature: 0.1,
      topP: 0.9,
      maxOutputTokens: 4096,
    },
  });

  const partes = [
    {
      fileData: {
        mimeType: archivoGemini.mimeType,
        fileUri: archivoGemini.uri,
      },
    },
    { text: PROMPT },
  ];

  let datos = null;
  let ultimoErrorJSON = null;

  for (let intento = 1; intento <= 2; intento += 1) {
    const partesIntento = intento === 1 ? partes : [...partes, { text: REFUERZO_JSON }];
    const resultado = await generarConReintentos(modelo, partesIntento);
    const texto = limpiarBloquesJSON(extraerTextoRespuesta(resultado));

    try {
      datos = JSON.parse(texto);
      break;
    } catch (error) {
      ultimoErrorJSON = error;
      console.warn(`[IA] JSON inválido en intento ${intento}: ${error.message}`);
    }
  }

  if (!datos) {
    console.error('[IA] Respuesta no parseable:', ultimoErrorJSON?.message);
    throw new ErrorHttp(
      502,
      'La IA devolvió una respuesta con formato inválido. Vuelve a intentarlo.',
      'JSON_INVALIDO'
    );
  }

  return normalizarExtraccion(datos);
}

function validarLegibilidad(paciente) {
  const camposNoRegistrados = CAMPOS_CLINICOS.filter((campo) => paciente[campo] === NO_REGISTRADO);

  if (camposNoRegistrados.length >= 9) {
    throw new ErrorHttp(
      422,
      'No se pudo leer información clínica del documento. Verifica que la imagen sea legible, esté derecha y no tenga contraseña.',
      'DOCUMENTO_ILEGIBLE'
    );
  }

  if (paciente.nombre === NO_REGISTRADO && paciente.documento === NO_REGISTRADO) {
    throw new ErrorHttp(
      422,
      'No se identificó al paciente en el documento. Asegúrate de subir la hoja de datos del paciente y no solo una página de exámenes.',
      'PACIENTE_NO_IDENTIFICADO'
    );
  }

  return camposNoRegistrados;
}


app.post('/api/upload', camposDeArchivo, async (req, res) => {
  const archivo = obtenerArchivoSubido(req);

  if (!archivo) {
    return res.status(400).json({ ok: false, codigo: 'SIN_ARCHIVO', error: 'No se recibió ningún archivo. Adjunta un PDF o una imagen en el campo "pdf".' });
  }

  try {
    console.log(`[UPLOAD] Procesando "${archivo.originalname}" (${(archivo.size / 1024).toFixed(0)} KB)...`);

    const archivoGemini = await prepararArchivoEnGemini(archivo.path, archivo.mimetype, archivo.originalname);
    const paciente = await analizarDocumento(archivoGemini);
    const camposNoRegistrados = validarLegibilidad(paciente);

    const creadoEn = new Date().toISOString();
    const clavePaciente = calcularClavePaciente(paciente);

    const resultado = await ejecutar(
      `INSERT INTO pacientes
        (nombre, documento, fecha_ingreso, edad, sexo, motivo_consulta, enfermedad_actual,
         signos_vitales, diagnostico, plan_tratamiento, medico, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paciente.nombre,
        paciente.documento,
        paciente.fecha_ingreso,
        paciente.edad,
        paciente.sexo,
        paciente.motivo_consulta,
        paciente.enfermedad_actual,
        paciente.signos_vitales,
        paciente.diagnostico,
        paciente.plan_tratamiento,
        paciente.medico,
        creadoEn,
      ]
    );

    console.log(`[OK] Paciente "${paciente.nombre}" guardado con id ${resultado.lastID}`);

    return res.status(201).json({
      ok: true,
      mensaje: 'Documento procesado y guardado correctamente.',
      id: resultado.lastID,
      clave_paciente: clavePaciente,
      campos_no_registrados: camposNoRegistrados,
      paciente: {
        ...paciente,
        id: resultado.lastID,
        clave_paciente: clavePaciente,
        creado_en: creadoEn,
      },
    });
  } catch (error) {
    const errorFinal = error instanceof ErrorHttp ? error : traducirErrorIA(error);
    console.error(`[ERROR] ${errorFinal.codigo}: ${errorFinal.message}`);
    return res.status(errorFinal.status || 500).json({
      ok: false,
      codigo: errorFinal.codigo || 'ERROR_INTERNO',
      error: errorFinal.message || 'Error interno procesando el documento.',
    });
  } finally {
    borrarArchivo(archivo.path);
  }
});

app.get('/api/pacientes', async (req, res) => {
  try {
    const filas = await consultar('SELECT * FROM pacientes');
    const pacientes = filas.map(normalizarFila).sort(ordenarPorFechaDescendente);
    return res.json(pacientes);
  } catch (error) {
    console.error('[DB] Error al listar pacientes:', error.message);
    return res.status(500).json({ ok: false, codigo: 'DB_ERROR', error: 'No se pudo consultar la base de datos de pacientes.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    servicio: 'Admisión Hospitalaria IA',
    modelo: MODELO,
    hora: new Date().toISOString(),
  });
});

app.use(express.static(DIR_FRONTEND));

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, codigo: 'RUTA_NO_ENCONTRADA', error: `La ruta ${req.method} ${req.originalUrl} no existe.` });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, codigo: 'ARCHIVO_MUY_GRANDE', error: 'El archivo supera el límite de 25 MB.' });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ ok: false, codigo: 'CAMPO_INVALIDO', error: 'Envía el archivo en el campo "pdf".' });
    }
    return res.status(400).json({ ok: false, codigo: 'ARCHIVO_INVALIDO', error: error.message });
  }

  if (error instanceof ErrorHttp) {
    return res.status(error.status).json({ ok: false, codigo: error.codigo, error: error.message });
  }

  console.error('[ERROR NO CONTROLADO]', error);
  return res.status(500).json({ ok: false, codigo: 'ERROR_INTERNO', error: 'Error interno del servidor.' });
});


async function iniciar() {
  try {
    await inicializarBaseDeDatos();
    app.listen(PORT, () => {
      console.log('──────────────────────────────────────────────');
      console.log('🏥  Admisión Hospitalaria IA');
      console.log(`    API:      http://localhost:${PORT}/api`);
      console.log(`    Frontend: http://localhost:${PORT}`);
      console.log(`    Modelo:   ${MODELO}`);
      console.log(`    SQLite:   ${RUTA_DB}`);
      console.log('──────────────────────────────────────────────');
    });
  } catch (error) {
    console.error('[FATAL] No se pudo iniciar el servidor:', error.message);
    process.exit(1);
  }
}

iniciar();
