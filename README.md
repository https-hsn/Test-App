# Site Manager

A self-hosted web app for a low current / ELV company: sites, site reports (work done + stock taken/returned),
visit scheduling, problems with photos, a stock log per site, a saved chat per site, and user accounts with roles
(Admin, CEO, General Manager, Project Manager, Supervisor, Engineer, Technician).

No database to install and no npm packages: just **Node.js 18 or newer**.

## 1. Run it

    unzip site-manager.zip && cd site-manager
    node server.js

On the very first start it creates the admin account and prints the password in the console
(also saved in `data/initial-admin-password.txt`).
Open `http://YOUR-SERVER:3000`, sign in as **admin**, and change the password (you are prompted).

Optional settings (environment variables):

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | port to listen on | 3000 |
| `HOST` | address to bind (use `127.0.0.1` behind a reverse proxy) | 0.0.0.0 |
| `DATA_DIR` | where the database and photos are stored | ./data |
| `ADMIN_PASSWORD` | choose the first admin password yourself | random |
| `TRUST_PROXY` | set to `1` when behind nginx/Cloudflare so HTTPS and client IPs are detected | off |

## 2. Put it on your domain (VPS, Ubuntu example)

1. Point your domain's DNS **A record** to the server's IP.
2. Install Node 18+ and nginx.
3. Copy the folder to `/opt/site-manager` and create `/etc/systemd/system/site-manager.service`:

       [Unit]
       Description=Site Manager
       After=network.target
       [Service]
       WorkingDirectory=/opt/site-manager
       ExecStart=/usr/bin/node server.js
       Environment=PORT=3000 HOST=127.0.0.1 TRUST_PROXY=1
       Restart=always
       User=www-data
       [Install]
       WantedBy=multi-user.target

   Then: `sudo chown -R www-data /opt/site-manager && sudo systemctl enable --now site-manager`
   (read the first admin password with `cat /opt/site-manager/data/initial-admin-password.txt`).
4. nginx site config:

       server {
         server_name yourdomain.com;
         client_max_body_size 10m;
         location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto $scheme;
         }
       }

   Enable it, then get free HTTPS: `sudo certbot --nginx -d yourdomain.com`.
   **Always use HTTPS**: passwords and photos travel over it.

Other options: **Docker** (`docker build -t site-manager . && docker run -d -p 3000:3000 -v sm-data:/data site-manager`),
or the **Node.js app** feature in cPanel/Plesk hosting (startup file: `server.js`).
Plain PHP-only shared hosting cannot run this app.

## 3. Backups and updates

Everything lives in the `data/` folder (`db.json` + `uploads/`). Back it up by copying that folder
(for example with a daily cron job). To update the app, replace `server.js` and `public/` and keep `data/`.

## 4. Roles

| Role | Can do |
|---|---|
| Admin | everything, plus create/edit/delete user accounts |
| CEO, General Manager, Project Manager | add sites, schedule visits, delete sites/reports/problems/chat/visits |
| Supervisor | add sites, schedule visits |
| Engineer, Technician | write reports (with stock taken/returned), report problems with photos, chat, mark visits done, mark problems solved |

Permissions are enforced on the server. Passwords are stored with scrypt; sessions use HttpOnly cookies;
login is rate-limited (10 failed attempts per IP per 15 minutes). Photos are only served to signed-in users.
