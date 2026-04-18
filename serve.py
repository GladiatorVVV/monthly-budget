import http.server, os, sys
os.chdir("/Users/kushrathod/Documents/Claude/Monthly Budget")
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=3333, bind="127.0.0.1")
