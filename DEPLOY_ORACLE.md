# Deploy en Oracle Cloud (Siempre Gratis)

## 1. Crear una VM en Oracle Cloud

1. Ve a https://cloud.oracle.com → Instancias → Crear instancia
2. Nombre: `diepio-bot`
3. Imagen: **Canonical Ubuntu 22.04** (o la más reciente)
4. Shape: **VM.Standard.A1.Flex** (ARM, Siempre Gratis)
   - OCPU: 4 (máximo gratis)
   - Memoria: 24 GB (máximo gratis)
5. Agrega tu clave SSH pública
6. Crea la instancia

## 2. Conectarse a la VM

```bash
ssh ubuntu@<IP_DE_TU_INSTANCIA>
```

## 3. Instalar Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Verificar:
```bash
node --version   # v20.x
npm --version
```

## 4. Clonar y configurar el bot

```bash
git clone <URL_DE_TU_REPO> diepio-bot
cd diepio-bot
cp .env.example .env
nano .env
```

Pega tu `DISCORD_TOKEN`, `GUILD_ID` y `CLIENT_ID` en `.env`.

> **CLIENT_ID**: En la página de la aplicación Discord, es el "Application ID" que aparece al inicio.

## 5. Instalar dependencias y compilar

```bash
npm install
npm run build
```

## 6. Crear servicio systemd (inicio automático)

```bash
sudo nano /etc/systemd/system/diepio-bot.service
```

Pega esto (ajusta la ruta):

```ini
[Unit]
Description=Diep.io Discord Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/diepio-bot
ExecStart=/usr/bin/node /home/ubuntu/diepio-bot/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable diepio-bot
sudo systemctl start diepio-bot
```

Ver logs:
```bash
sudo journalctl -u diepio-bot -f
```

## 7. Firewall (opcional)

Oracle ya bloquea por defecto. No necesitas abrir puertos.

## Mantenimiento

- **Reiniciar bot:** `sudo systemctl restart diepio-bot`
- **Ver logs:** `sudo journalctl -u diepio-bot -f`
- **Actualizar código:** `git pull && npm install && npm run build && sudo systemctl restart diepio-bot`
- **Respaldar DB:** La base de datos SQLite está en `data/diepio.db`

## Crear el bot en Discord

1. Ve a https://discord.com/developers/applications
2. New Application → nombre: `Diep.io Bot`
3. Bot → Add Bot → Reset Token → **copia el token**
4. Bot → Privileged Gateway Intents: activa **Message Content Intent**
5. Bot → **Manage Nicknames** (necesario para que el bot cambie el nombre con el ELO)
6. OAuth2 → URL Generator → bot → Send Messages, Read Messages, Embed Links, Use Slash Commands, Change Nickname
7. Abre la URL generada e invita el bot a tu servidor
8. Pon el token, client ID y guild ID en `.env`
