#!/bin/bash

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js (using NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Install Nginx
sudo apt install -y nginx

# Setup Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# Clone/Copy app (assuming we are in the app directory or git clone here)
# For this script, we assume the user will SCP the files or git clone.
# We just setup the environment.

# Start app with PM2
# pm2 start server.js --name m3u8-proxy
# pm2 save
# pm2 startup

echo "Environment setup complete. Please configure Nginx and start the app."
