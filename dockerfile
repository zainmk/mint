# Stage 1: Build the React app
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve the app with Nginx
FROM nginx:stable-alpine
# Remove default Nginx content
RUN rm -rf /usr/share/nginx/html/*
# Copy the build output from the 'build' stage to the Nginx container's serving directory
COPY --from=build /app/build /usr/share/nginx/html
# Expose port 80 (Nginx default)
EXPOSE 80
# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
