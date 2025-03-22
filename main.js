const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');

let mainWindow;
let server;
let clients = new Map();
let downloads = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,  // This must be true to use Node.js APIs like `net`
      contextIsolation: false
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools();  // Optional: Open DevTools for debugging

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function sendToClient(socket, command) {
  return new Promise((resolve, reject) => {
    try {
      const jsonCommand = JSON.stringify(command);
      const messageBuffer = Buffer.from(jsonCommand, 'utf-8');
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(messageBuffer.length);

      console.log(`Sending command to client: ${command.type}`);
      
      // Send length first
      socket.write(lengthBuffer, (err) => {
        if (err) {
          console.error('Error sending message length:', err);
          reject(err);
          return;
        }
        
        // Then send the actual message
        socket.write(messageBuffer, (err) => {
          if (err) {
            console.error('Error sending message data:', err);
            reject(err);
            return;
          }
          console.log('Command sent successfully');
          resolve(true);
        });
      });
    } catch (error) {
      console.error('Error sending command to client:', error);
      reject(error);
    }
  });
}

// Helper function to read a complete message
function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let lengthBuffer = Buffer.alloc(0);
    let messageBuffer = Buffer.alloc(0);
    let messageLength = null;
    
    function onData(chunk) {
      try {
        if (messageLength === null) {
          // Still reading length
          lengthBuffer = Buffer.concat([lengthBuffer, chunk]);
          if (lengthBuffer.length >= 4) {
            messageLength = lengthBuffer.readUInt32BE(0);
            // Start reading message with any remaining data
            messageBuffer = Buffer.concat([messageBuffer, lengthBuffer.slice(4)]);
          }
        } else {
          // Reading message
          messageBuffer = Buffer.concat([messageBuffer, chunk]);
        }
        
        if (messageLength !== null && messageBuffer.length >= messageLength) {
          // We have a complete message
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          resolve(messageBuffer.slice(0, messageLength).toString('utf-8'));
        }
      } catch (error) {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        reject(error);
      }
    }
    
    function onError(error) {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(error);
    }
    
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

ipcMain.on('start-server', (event, port) => {
  server = net.createServer((socket) => {
    console.log('Client connected');
    
    // Handle incoming messages
    async function handleMessages() {
      try {
        while (true) {
          const message = await readMessage(socket);
          if (!message) break;
          
          try {
            const data = JSON.parse(message);
            
            if (data.type === 'init') {
              // Initial connection data
              const clientInfo = data.data;
              clients.set(clientInfo.hostname, { socket, info: clientInfo });
              mainWindow.webContents.send('client-connected', clientInfo);
            } else if (data.status === 'success' && data.data && data.path) {
              // Handle file download chunks
              const download = downloads.get(data.path);
              if (download) {
                const { writeStream } = download;
                const fileData = Buffer.from(data.data, 'base64');
                writeStream.write(fileData);

                if (data.finished) {
                  writeStream.end();
                  downloads.delete(data.path);
                  mainWindow.webContents.send('download-complete', {
                    path: data.path
                  });
                }
              }
            } else if (data.type === 'delete-response') {
              // Handle delete response
              mainWindow.webContents.send('delete-complete', data);
            } else {
              // Other responses (browse, etc.)
              mainWindow.webContents.send('update-file-browser', data);
            }
          } catch (error) {
            console.error('Error parsing client data:', error);
          }
        }
      } catch (error) {
        console.error('Error reading messages:', error);
      }
    }
    
    handleMessages().catch(console.error);

    socket.on('close', () => {
      // Find and remove the disconnected client
      for (const [hostname, client] of clients.entries()) {
        if (client.socket === socket) {
          clients.delete(hostname);
          if (mainWindow) {
            mainWindow.webContents.send('client-disconnected', hostname);
          }
          break;
        }
      }
      console.log('Client disconnected');
    });

    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  });

  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  server.on('error', (err) => {
    console.error('Server error:', err);
    mainWindow.webContents.send('server-error', err.message);
  });
});

ipcMain.on('stop-server', () => {
  if (server) {
    // Send exit command to all connected clients
    for (const [hostname, client] of clients.entries()) {
      sendToClient(client.socket, { type: 'exit' });
    }
    
    server.close(() => {
      console.log('Server stopped');
      clients.clear();
    });
    server = null;
  }
});

ipcMain.on('browse-files', async (event, data) => {
    const client = clients.get(data.hostname);
    if (!client) {
        console.error('No client found for hostname:', data.hostname);
        return;
    }

    try {
        console.log('Browsing files at path:', data.path);
        await sendToClient(client.socket, {
            type: 'browse',
            path: data.path || '.'
        });
    } catch (error) {
        console.error('Error browsing files:', error);
        mainWindow.webContents.send('browse-error', {
            message: error.message
        });
    }
});

ipcMain.on('exit-client', (event, hostname) => {
  const client = clients.get(hostname);
  if (client) {
    sendToClient(client.socket, { type: 'exit' });
    // The client will disconnect itself, triggering the 'close' event
  }
});

ipcMain.on('exit-app', () => {
  // Send exit command to all connected clients before quitting
  for (const [hostname, client] of clients.entries()) {
    sendToClient(client.socket, { type: 'exit' });
  }
  app.quit();
});

ipcMain.on('download-files', async (event, data) => {
    const client = clients.get(data.hostname);
    if (!client) return;

    try {
        for (const filePath of data.files) {
            const fileName = path.basename(filePath);
            
            // Show save dialog for each file
            const { filePath: savePath, canceled } = await dialog.showSaveDialog(mainWindow, {
                title: 'Save File As',
                defaultPath: fileName,
                buttonLabel: 'Save',
                properties: ['showOverwriteConfirmation']
            });

            if (!canceled && savePath) {
                // Create a write stream for the file
                const writeStream = fs.createWriteStream(savePath);
                let isFirstChunk = true;

                // Send download request to client
                sendToClient(client.socket, {
                    type: 'download',
                    path: filePath
                });

                // Store the write stream for this download
                downloads.set(filePath, {
                    writeStream,
                    isFirstChunk
                });
            }
        }
    } catch (error) {
        console.error('Error initiating download:', error);
        mainWindow.webContents.send('download-error', {
            message: error.message
        });
    }
});

ipcMain.on('delete-files', (event, data) => {
    const client = clients.get(data.hostname);
    if (client) {
        sendToClient(client.socket, {
            type: 'delete',
            files: data.files
        });
    }
});

ipcMain.on('show-upload-dialog', async (event, data) => {
    const client = clients.get(data.hostname);
    if (!client) return;

    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile', 'multiSelections'],
            title: 'Select Files to Upload'
        });

        if (!filePaths || filePaths.length === 0) return;

        let uploadCount = filePaths.length;
        let completedUploads = 0;

        const refreshDirectory = async () => {
            completedUploads++;
            if (completedUploads === uploadCount) {
                console.log('All uploads completed, refreshing directory:', data.currentPath);
                // Add a small delay to ensure file system has synchronized
                await new Promise(resolve => setTimeout(resolve, 100));
                // Ensure we have a valid path to refresh
                const refreshPath = data.currentPath || '.';
                await sendToClient(client.socket, {
                    type: 'browse',
                    path: refreshPath
                });
            }
        };

        for (const filePath of filePaths) {
            const fileName = path.basename(filePath);
            const targetPath = path.join(data.currentPath || '.', fileName);
            
            console.log('Upload details:', {
                sourceFile: filePath,
                targetPath: targetPath,
                currentPath: data.currentPath || '.'
            });
            
            try {
                const stats = fs.statSync(filePath);
                if (stats.size === 0) {
                    console.error(`File ${fileName} is empty`);
                    mainWindow.webContents.send('upload-error', {
                        fileName,
                        message: 'File is empty'
                    });
                    await refreshDirectory();
                    continue;
                }

                // Notify upload start
                mainWindow.webContents.send('upload-started', { fileName });

                const fileStream = fs.createReadStream(filePath);
                let isFirstChunk = true;
                let bytesUploaded = 0;
                const totalSize = stats.size;

                // Use promises to ensure sequential chunk sending
                const processChunk = async (chunk) => {
                    const base64Data = chunk.toString('base64');
                    const command = {
                        type: 'upload',
                        path: targetPath,
                        data: base64Data,
                        append: !isFirstChunk
                    };
                    
                    bytesUploaded += chunk.length;
                    const progress = Math.round((bytesUploaded / totalSize) * 100);
                    mainWindow.webContents.send('upload-progress', {
                        fileName,
                        progress
                    });
                    
                    console.log(`Sending chunk for ${targetPath}, size: ${chunk.length}, progress: ${progress}%`);
                    await sendToClient(client.socket, command);
                    isFirstChunk = false;
                };

                // Handle the stream with async/await
                for await (const chunk of fileStream) {
                    await processChunk(chunk);
                }

                console.log(`All chunks sent for ${targetPath}, sending completion signal`);
                await sendToClient(client.socket, {
                    type: 'upload-complete',
                    path: targetPath
                });

                // Wait for the upload completion response before refreshing
                const uploadResponse = await readMessage(client.socket);
                const responseData = JSON.parse(uploadResponse);
                
                if (responseData.status === 'success') {
                    console.log(`Upload completed successfully for ${targetPath}`);
                    mainWindow.webContents.send('upload-complete', { fileName });
                    await refreshDirectory();
                } else {
                    console.error('Upload failed:', responseData.message);
                    mainWindow.webContents.send('upload-error', {
                        fileName,
                        message: responseData.message
                    });
                    await refreshDirectory();
                }

            } catch (error) {
                console.error(`Error processing ${fileName}:`, error);
                mainWindow.webContents.send('upload-error', {
                    fileName,
                    message: error.message
                });
                await refreshDirectory();
            }
        }
    } catch (error) {
        console.error('Error initiating upload:', error);
        mainWindow.webContents.send('upload-error', {
            message: error.message
        });
    }
});

