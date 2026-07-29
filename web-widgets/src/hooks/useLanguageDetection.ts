import { useLocation } from 'react-router-dom';

/**
 * Hook to detect if the current page is in Spanish based on the URL
 * @returns boolean indicating if the current page is Spanish
 */
export const useLanguageDetection = (): boolean => {
  const location = useLocation();
  
  // Determine if current page is Spanish based on route
  const isSpanishPage = location.pathname.endsWith('ES') || 
                       location.pathname.includes('ES/') ||
                       location.pathname === '/HomeES';
  
  return isSpanishPage;
};