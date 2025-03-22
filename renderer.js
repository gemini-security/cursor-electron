const { ipcRenderer } = require('electron');
const path = require('path');

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const portInput = document.getElementById('portInput');
const clientsTable = document.getElementById('clientsTable').getElementsByTagName('tbody')[0];
const exitButton = document.getElementById('exitButton');
const contextMenu = document.getElementById('contextMenu');
const fileBrowserDialog = document.getElementById('fileBrowserDialog');
const overlay = document.getElementById('overlay');
const currentPath = document.getElementById('currentPath');
const fileList = document.getElementById('fileList');
const closeBrowserButton = document.getElementById('closeBrowserButton');
const goButton = document.getElementById('goButton');
const downloadButton = document.getElementById('downloadButton');
const deleteButton = document.getElementById('deleteButton');
const uploadButton = document.getElementById('uploadButton');

let selectedClient = null;
let selectedFiles = new Set();
let uploadInProgress = false;
const uploadStatus = document.createElement('div');
uploadStatus.className = 'upload-status';
uploadStatus.style.display = 'none';
uploadStatus.style.position = 'absolute';
uploadStatus.style.bottom = '10px';
uploadStatus.style.left = '10px';
uploadStatus.style.right = '10px';
uploadStatus.style.padding = '10px';
uploadStatus.style.backgroundColor = '#f0f0f0';
uploadStatus.style.border = '1px solid #ccc';
uploadStatus.style.borderRadius = '4px';
fileBrowserDialog.appendChild(uploadStatus);

// Server control functions
startButton.addEventListener('click', () => {
    const port = parseInt(portInput.value);
    if (isNaN(port) || port < 1 || port > 65535) {
        alert('Please enter a valid port number between 1 and 65535');
        return;
    }
    ipcRenderer.send('start-server', port);
    startButton.disabled = true;
    stopButton.disabled = false;
});

stopButton.addEventListener('click', () => {
    ipcRenderer.send('stop-server');
    startButton.disabled = false;
    stopButton.disabled = true;
    clearTable();
});

exitButton.addEventListener('click', () => {
    ipcRenderer.send('exit-app');
});

// Context menu functions
function showContextMenu(event, client) {
    event.preventDefault();
    selectedClient = client;
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${event.pageX}px`;
    contextMenu.style.top = `${event.pageY}px`;
}

// Hide context menu when clicking outside
document.addEventListener('click', (event) => {
    if (!contextMenu.contains(event.target)) {
        contextMenu.style.display = 'none';
    }
});

// File browser functions
document.getElementById('fileBrowserOption').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (selectedClient) {
        ipcRenderer.send('browse-files', { hostname: selectedClient.hostname, path: '.' });
        showFileBrowser();
    }
});

document.getElementById('exitConnectionOption').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (selectedClient) {
        ipcRenderer.send('exit-client', selectedClient.hostname);
    }
});

function showFileBrowser() {
    overlay.style.display = 'block';
    fileBrowserDialog.style.display = 'flex';
    selectedFiles.clear();
    updateActionButtons();
}

function hideFileBrowser() {
    overlay.style.display = 'none';
    fileBrowserDialog.style.display = 'none';
    fileList.innerHTML = '';
    currentPath.value = '';
    selectedFiles.clear();
}

function updateActionButtons() {
    const hasSelection = selectedFiles.size > 0;
    downloadButton.disabled = !hasSelection;
    deleteButton.disabled = !hasSelection;
}

goButton.addEventListener('click', () => {
    if (selectedClient && currentPath.value) {
        ipcRenderer.send('browse-files', {
            hostname: selectedClient.hostname,
            path: currentPath.value
        });
    }
});

currentPath.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        goButton.click();
    }
});

downloadButton.addEventListener('click', () => {
    if (selectedFiles.size > 0) {
        ipcRenderer.send('download-files', {
            hostname: selectedClient.hostname,
            files: Array.from(selectedFiles)
        });
    }
});

deleteButton.addEventListener('click', () => {
    if (selectedFiles.size > 0 && confirm('Are you sure you want to delete the selected files?')) {
        const currentDir = currentPath.value;  // Store current directory
        ipcRenderer.send('delete-files', {
            hostname: selectedClient.hostname,
            files: Array.from(selectedFiles),
            currentDirectory: currentDir  // Send current directory
        });
    }
});

// Handle delete response
ipcRenderer.on('delete-complete', (event, data) => {
    if (data.status === 'success') {
        // Refresh the current directory
        ipcRenderer.send('browse-files', {
            hostname: selectedClient.hostname,
            path: currentPath.value
        });
    } else {
        alert('Error deleting files: ' + data.message);
    }
});

function updateUploadStatus(message) {
    if (message) {
        uploadStatus.textContent = message;
        uploadStatus.style.display = 'block';
    } else {
        uploadStatus.style.display = 'none';
    }
}

uploadButton.addEventListener('click', () => {
    if (!uploadInProgress) {
        ipcRenderer.send('show-upload-dialog', {
            hostname: selectedClient.hostname,
            currentPath: currentPath.value
        });
    }
});

closeBrowserButton.addEventListener('click', hideFileBrowser);
overlay.addEventListener('click', hideFileBrowser);

function clearTable() {
    while (clientsTable.firstChild) {
        clientsTable.removeChild(clientsTable.firstChild);
    }
}

function createFileItem(item) {
    const div = document.createElement('div');
    div.className = 'file-item';
    
    if (item.type === 'file') {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'checkbox';
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedFiles.add(item.path);
            } else {
                selectedFiles.delete(item.path);
            }
            updateActionButtons();
        });
        div.appendChild(checkbox);
    }
    
    const icon = document.createElement('i');
    icon.className = item.type === 'directory' ? 'folder-icon' : 'file-icon';
    icon.textContent = item.type === 'directory' ? '📁 ' : '📄 ';
    
    const name = document.createElement('span');
    name.textContent = item.name;
    
    div.appendChild(icon);
    div.appendChild(name);
    
    if (item.type === 'directory') {
        div.addEventListener('click', () => {
            let newPath;
            if (item.name === '..') {
                // Use the path provided by the Python client for parent directory
                newPath = item.path;
            } else {
                newPath = path.join(currentPath.value, item.name);
            }
            
            console.log('Navigating to:', newPath);
            ipcRenderer.send('browse-files', {
                hostname: selectedClient.hostname,
                path: newPath
            });
        });
    }
    
    return div;
}

// Handle client connections
ipcRenderer.on('client-connected', (event, clientInfo) => {
    const row = clientsTable.insertRow();
    row.insertCell(0).textContent = clientInfo.hostname;
    row.insertCell(1).textContent = clientInfo.username;
    row.insertCell(2).textContent = clientInfo.os;
    
    // Store client info in the row
    row.clientInfo = clientInfo;
    
    // Add right-click event listener
    row.addEventListener('contextmenu', (e) => showContextMenu(e, clientInfo));
});

// Handle client disconnections
ipcRenderer.on('client-disconnected', (event, hostname) => {
    for (let i = 0; i < clientsTable.rows.length; i++) {
        if (clientsTable.rows[i].cells[0].textContent === hostname) {
            clientsTable.deleteRow(i);
            if (selectedClient && selectedClient.hostname === hostname) {
                hideFileBrowser();
            }
            break;
        }
    }
});

// Handle file browser updates
ipcRenderer.on('update-file-browser', (event, data) => {
    if (data.status === 'success') {
        currentPath.value = data.current_path;
        fileList.innerHTML = '';
        selectedFiles.clear();
        updateActionButtons();
        
        // Add all items from the current directory
        // The Python client already includes the parent directory entry when needed
        data.contents.forEach(item => {
            fileList.appendChild(createFileItem(item));
        });
    } else {
        // Show error message in the file browser
        fileList.innerHTML = '';
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.style.padding = '20px';
        errorDiv.style.color = 'red';
        errorDiv.textContent = `Error: ${data.message}`;
        fileList.appendChild(errorDiv);
    }
});

// Handle server errors
ipcRenderer.on('server-error', (event, errorMessage) => {
    alert('Server error: ' + errorMessage);
    startButton.disabled = false;
    stopButton.disabled = true;
});

// Add these event listeners for upload status
ipcRenderer.on('upload-started', (event, data) => {
    uploadInProgress = true;
    updateUploadStatus(`Uploading ${data.fileName}...`);
});

ipcRenderer.on('upload-progress', (event, data) => {
    updateUploadStatus(`Uploading ${data.fileName}: ${data.progress}%`);
});

ipcRenderer.on('upload-complete', (event, data) => {
    uploadInProgress = false;
    updateUploadStatus(null);
});

ipcRenderer.on('upload-error', (event, data) => {
    uploadInProgress = false;
    updateUploadStatus(`Error uploading ${data.fileName}: ${data.message}`);
    setTimeout(() => updateUploadStatus(null), 3000);
}); 