# Guía de Pruebas: jDocMunch Microservice

Este microservicio permite realizar consultas ultra-rápidas al libro indexado de la "Familia Zero" sin necesidad de volver a leer el archivo completo.

## 1. Cómo iniciar el servidor
Desde una terminal en el directorio del proyecto:

```bash
cd c:\Users\Sebastián\.gemini\antigravity\playground\holographic-lagoon\jdocmunch-service
node server.js
```

## 2. Cómo realizar pruebas de latencia (CLI)
Abre **otra terminal** y ejecuta el cliente CLI especificando tu pregunta:

```bash
node cli.js "¿Cuáles son los 10 bloqueos?"
```

El resultado mostrará:
- **Total Session Latency**: El tiempo total desde que lanzas el comando hasta que recibes la respuesta.
- **jDocMunch Internal Latency**: El tiempo que tardó el motor de búsqueda en consultar el índice.

## 3. Uso como Microservicio (HTTP)
Puedes integrar esto en cualquier frontend o backend consultando los endpoints:

- **Búsqueda**: `GET http://localhost:3000/search?q=tu-pregunta`
- **Contenido**: `GET http://localhost:3000/section/:id`

## 4. Instrucciones para el AGENTE (Próximas Sesiones)
Si inicias una nueva sesión y quieres que el agente pruebe el servicio:
1. Pídele: *"Inicia el microservicio en `jdocmunch-service` y dime la latencia para la pregunta X"*.
2. El agente debería:
   - Ejecutar `node server.js` en segundo plano.
   - Ejecutar `node cli.js "pregunta"` y reportar los milisegundos.

---
**Nota:** El servicio asume que el repositorio `local/holographic-lagoon` ya está indexado.
