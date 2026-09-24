FROM nginx:1.27-alpine AS builder
WORKDIR /site
COPY . .
RUN mkdir -p /out \
    && cp -r *.html *.css *.js /out/ 2>/dev/null || true \
    && if [ -d assets ]; then cp -r assets /out/assets; fi \
    && if [ -d public ]; then cp -r public/* /out/; fi

FROM nginx:1.27-alpine
COPY --from=builder /out /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
