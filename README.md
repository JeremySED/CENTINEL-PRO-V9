# SENTINEL PRO WEB — Sistema de Videovigilancia Táctica AI

Aplicación web de videovigilancia en tiempo real **100% compatible con macOS, Windows y Linux** directamente desde el navegador (GitHub Pages), sin instalar Python ni VS Code.

## Funcionalidades
- **Detección en tiempo real (TensorFlow.js WebGL/GPU):** Personas, armas blancas (`knife`, `scissors`), objetos contundentes (`baseball bat`), autos, motos, vehículos pesados y equipaje/bultos.
- **Analítica biomecánica (MoveNet MultiPose):**
  - Detección de **posible asalto (manos arriba)**.
  - Detección de **persona caída** con filtro anti-falsos positivos (ignora vistas parciales o solo cabeza).
  - Detección de **forcejeo / pelea**, **2 personas en moto**, **merodeo**, **intrusión en zona restringida** y **objeto abandonado**.
- **Soporte multi-cámara y video CCTV:** Botón **Cambiar Cámara** (alterna entre cámara interna y cámaras USB externas) y carga directa de archivos `.mp4`.
- **Slot especialista ONNX opcional:** Permite cargar un modelo YOLO entrenado en armas de fuego o cascos exportado a `.onnx` (`yolo export model=tu_modelo.pt format=onnx imgsz=640`) o colocarlo en `models/armas.onnx` para carga automática.
- **Consola forense integrada:** Grabación DVR (`.webm`), zoom táctico PiP, mapa de calor, radar 2D, capturas con recorte y exportación de bitácora a `.csv`.

## Activación en GitHub Pages
1. Subir el contenido de esta carpeta a la raíz del repositorio en GitHub.
2. Ir a **Settings → Pages**.
3. En **Build and deployment**, elegir **Deploy from a branch**, rama `main` y carpeta `/ (root)`.
4. Guardar y abrir el enlace HTTPS generado (`https://TU-USUARIO.github.io/TU-REPO/`).
