AI RESCUE qvac-sos
Sistema de ayuda en situaciones de desastre, 100% offline, que usa IA local (QVAC SDK de Tether) para traducir conversaciones en tiempo real y extraer automáticamente una ficha estructurada de la persona atendida.
> **Nota:** esta es la versión que procesa un archivo de audio (`test.wav`) fijo — pensada para pruebas y demos controladas. La versión con micrófono en vivo está en un proyecto aparte (`qvac-sos1`).
Qué hace
Transcribe un archivo de audio a texto (Whisper, local)
Traduce ese texto a otro idioma (Bergamot, local)
Extrae automáticamente datos estructurados de la conversación con un modelo de lenguaje local (nombre, edad, nacionalidad, estado de salud, alergias, medicamentos, nivel de urgencia, etc.)
Nunca confía ciegamente en la IA: todo dato extraído queda marcado como borrador (`ai_draft`) hasta que un humano lo confirme. Si la IA contradice un dato ya confirmado, se genera una alerta visible en vez de sobrescribirlo en silencio
Ubicación: intenta obtener GPS de un dispositivo conectado; si no hay, pregunta coordenadas o dirección
Sincroniza la ficha (y su transcripción completa) con otros dispositivos cercanos en la misma red local, sin necesidad de internet
Guarda todo en archivos locales (`records/`), listos para transferir entre dispositivos
Tecnologías
Componente	Tecnología
IA (transcripción, traducción, extracción)	QVAC SDK — Whisper, Bergamot, Qwen3
Runtime	Node.js (ES Modules)
Empaquetado / compatibilidad	Docker (`node:22-bookworm`)
Sincronización P2P	Hyperswarm
Almacenamiento	JSON / JSONL (archivos locales)
Requisitos
Docker instalado
Un archivo de audio de prueba (`test.wav`) en la raíz del proyecto
Estructura del proyecto
```
qvac-sos/
├── translate.js          # script principal: transcribe → traduce → extrae → guarda
├── record-schema.js       # esquema de la ficha de persona (campos, categorías fijas)
├── extract.js              # extracción de datos con IA, por grupos de campos
├── sync.js                # sincronización P2P entre dispositivos (Hyperswarm)
├── gps.js                  # captura de ubicación (GPS o manual)
├── records/                # fichas guardadas + transcripciones completas
├── Dockerfile
├── .dockerignore
└── test.wav                 # audio de prueba
```
Instalación y uso
```bash
# 1. Instalar dependencias del proyecto
npm install

# 2. Construir la imagen Docker
docker build -t qvac-sos .

# 3. Ejecutar (la primera vez descarga los modelos — requiere internet)
docker run -it --rm --init --network host \
  -v $(pwd)/records:/app/records \
  -v $(pwd)/test.wav:/app/test.wav \
  -v $(pwd)/.qvac-cache:/root \
  qvac-sos
```
Después de la primera ejecución, los modelos quedan cacheados en `.qvac-cache/` y el sistema funciona completamente offline.
Para probar con otro audio sin reconstruir la imagen:
```bash
docker run -it --rm --init --network host \
  -v $(pwd)/records:/app/records \
  -v $(pwd)/mi-audio.wav:/app/test.wav \
  -v $(pwd)/.qvac-cache:/root \
  qvac-sos
```
Notas
El nivel de urgencia (`triageLevel`) usa una categorización fija: `immediate`, `delayed`, `minor`, `uninjured`, `deceased`, `unknown`
La extracción de datos corre en varias llamadas separadas a la IA (por grupo de campos) en vez de una sola, ya que mejora mucho la precisión con modelos más chicos
El campo `flags` en cada ficha muestra contradicciones detectadas por la IA que un agente humano todavía no revisó
